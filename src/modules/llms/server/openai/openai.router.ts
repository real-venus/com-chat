import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { createTRPCRouter, publicProcedure } from '~/server/api/trpc.server';
import { env } from '~/server/env.mjs';
import { fetchJsonOrTRPCError } from '~/server/api/trpc.serverutils';

import { t2iCreateImagesOutputSchema } from '~/modules/t2i/t2i.server.types';

import { Brand } from '~/common/app.config';
import { fixupHost } from '~/common/util/urlUtils';

import { OpenAIWire, WireOpenAICreateImageOutput, wireOpenAICreateImageOutputSchema, WireOpenAICreateImageRequest } from './openai.wiretypes';
import { llmsChatGenerateWithFunctionsOutputSchema, llmsListModelsOutputSchema, ModelDescriptionSchema } from '../llm.server.types';
import { lmStudioModelToModelDescription, localAIModelToModelDescription, mistralModelsSort, mistralModelToModelDescription, oobaboogaModelToModelDescription, openAIModelToModelDescription, openRouterModelFamilySortFn, openRouterModelToModelDescription, togetherAIModelsToModelDescriptions } from './models.data';


const openAIDialects = z.enum([
  'azure', 'lmstudio', 'localai', 'mistral', 'oobabooga', 'openai', 'openrouter', 'togetherai',
]);

export const openAIAccessSchema = z.object({
  dialect: openAIDialects,
  oaiKey: z.string().trim(),
  oaiOrg: z.string().trim(),
  oaiHost: z.string().trim(),
  heliKey: z.string().trim(),
  moderationCheck: z.boolean(),
  defaultCheck: z.boolean(),
});
export type OpenAIAccessSchema = z.infer<typeof openAIAccessSchema>;

export const openAIModelSchema = z.object({
  id: z.string(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().min(1).max(1000000).optional(),
});
export type OpenAIModelSchema = z.infer<typeof openAIModelSchema>;

export const openAIHistorySchema = z.array(z.object({
  role: z.enum(['assistant', 'system', 'user'/*, 'function'*/]),
  content: z.string(),
}));
export type OpenAIHistorySchema = z.infer<typeof openAIHistorySchema>;

export const openAIFunctionsSchema = z.array(z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.object({
    type: z.literal('object'),
    properties: z.record(z.object({
      type: z.enum(['string', 'number', 'integer', 'boolean']),
      description: z.string().optional(),
      enum: z.array(z.string()).optional(),
    })),
    required: z.array(z.string()).optional(),
  }).optional(),
}));
export type OpenAIFunctionsSchema = z.infer<typeof openAIFunctionsSchema>;


// Router Input Schemas

const listModelsInputSchema = z.object({
  access: openAIAccessSchema,
});

const chatGenerateWithFunctionsInputSchema = z.object({
  access: openAIAccessSchema,
  model: openAIModelSchema, history: openAIHistorySchema,
  functions: openAIFunctionsSchema.optional(), forceFunctionName: z.string().optional(),
});

const createImagesInputSchema = z.object({
  access: openAIAccessSchema,
  request: z.object({
    prompt: z.string(),
    count: z.number().min(1),
    model: z.enum(['dall-e-2', 'dall-e-3']),
    quality: z.enum(['standard', 'hd']),
    asUrl: z.boolean(), // if false, returns a base64 encoded data Url
    size: z.enum(['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792']),
    style: z.enum(['natural', 'vivid']),
  }),
});

const moderationInputSchema = z.object({
  access: openAIAccessSchema,
  text: z.string(),
});


export const llmOpenAIRouter = createTRPCRouter({

  /* [OpenAI] List the Models available */
  listModels: publicProcedure
    .input(listModelsInputSchema)
    .output(llmsListModelsOutputSchema)
    .query(async ({ input: { access } }): Promise<{ models: ModelDescriptionSchema[] }> => {

      let models: ModelDescriptionSchema[];

      // [Azure]: use an older 'deployments' API to enumerate the models, and a modified OpenAI id to description mapping
      if (access.dialect === 'azure') {
        const azureModels = await openaiGET(access, `/openai/deployments?api-version=2023-03-15-preview`);

        const wireAzureListDeploymentsSchema = z.object({
          data: z.array(z.object({
            model: z.string(), // the OpenAI model id
            owner: z.enum(['organization-owner']),
            id: z.string(), // the deployment name
            status: z.enum(['succeeded']),
            created_at: z.number(),
            updated_at: z.number(),
            object: z.literal('deployment'),
          })),
          object: z.literal('list'),
        });
        const azureWireModels = wireAzureListDeploymentsSchema.parse(azureModels).data;

        // only take 'gpt' models
        models = azureWireModels
          .filter(m => m.model.includes('gpt'))
          .map((model): ModelDescriptionSchema => {
            const { id: deploymentRef, model: openAIModelId } = model;
            const { id: _deleted, label, ...rest } = openAIModelToModelDescription(openAIModelId, model.created_at, model.updated_at);
            return {
              id: deploymentRef,
              label: `${label} (${deploymentRef})`,
              ...rest,
            };
          });
        return { models };
      }


      // [non-Azure]: fetch openAI-style for all but Azure (will be then used in each dialect)
      const openAIWireModelsResponse = await openaiGET<OpenAIWire.Models.Response>(access, '/v1/models');

      // [Together] missing the .data property
      if (access.dialect === 'togetherai')
        return { models: togetherAIModelsToModelDescriptions(openAIWireModelsResponse) };

      let openAIModels: OpenAIWire.Models.ModelDescription[] = openAIWireModelsResponse.data || [];

      // de-duplicate by ids (can happen for local servers.. upstream bugs)
      const preCount = openAIModels.length;
      openAIModels = openAIModels.filter((model, index) => openAIModels.findIndex(m => m.id === model.id) === index);
      if (preCount !== openAIModels.length)
        console.warn(`openai.router.listModels: removed ${preCount - openAIModels.length} duplicate models for dialect ${access.dialect}`);

      // sort by id
      openAIModels.sort((a, b) => a.id.localeCompare(b.id));

      // every dialect has a different way to enumerate models - we execute the mapping on the server side
      switch (access.dialect) {

        case 'lmstudio':
          models = openAIModels
            .map(({ id }) => lmStudioModelToModelDescription(id));
          break;

        // [LocalAI]: map id to label
        case 'localai':
          models = openAIModels
            .map(model => localAIModelToModelDescription(model.id));
          break;

        case 'mistral':
          models = openAIModels
            .map(mistralModelToModelDescription)
            .sort(mistralModelsSort);
          break;

        // [Oobabooga]: remove virtual models, hidden by default
        case 'oobabooga':
          models = openAIModels
            .map(model => oobaboogaModelToModelDescription(model.id, model.created))
            .filter(model => !model.hidden);
          break;

        // [OpenAI]: chat-only models, custom sort, manual mapping
        case 'openai':
          models = openAIModels

            // limit to only 'gpt' and 'non instruct' models
            .filter(model => model.id.includes('gpt') && !model.id.includes('-instruct'))

            // custom openai sort
            .sort((a, b) => {
              const aId = a.id.slice(0, 5);
              const bId = b.id.slice(0, 5);
              if (aId === bId) {
                const aCount = a.id.split('-').length;
                const bCount = b.id.split('-').length;
                if (aCount === bCount)
                  return a.id.localeCompare(b.id);
                return aCount - bCount;
              }
              return bId.localeCompare(aId);
            })

            // to model description
            .map((model): ModelDescriptionSchema => openAIModelToModelDescription(model.id, model.created));
          break;

        case 'openrouter':
          models = openAIModels
            .sort(openRouterModelFamilySortFn)
            .map(openRouterModelToModelDescription);
          break;

      }

      return { models };
    }),

  /* [OpenAI] (non streaming) chat generation */
  chatGenerateWithFunctions: publicProcedure
    .input(chatGenerateWithFunctionsInputSchema)
    .output(llmsChatGenerateWithFunctionsOutputSchema)
    .mutation(async ({ input }) => {

      const { access, model, history, functions, forceFunctionName } = input;
      const isFunctionsCall = !!functions && functions.length > 0;

      const wireCompletions = await openaiPOST<OpenAIWire.ChatCompletion.Response, OpenAIWire.ChatCompletion.Request>(
        access, model.id,
        openAIChatCompletionPayload(model, history, isFunctionsCall ? functions : null, forceFunctionName ?? null, 1, false),
        '/v1/chat/completions',
      );

      // expect a single output
      if (wireCompletions?.choices?.length !== 1)
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `[OpenAI Issue] Expected 1 completion, got ${wireCompletions?.choices?.length}` });
      let { message, finish_reason } = wireCompletions.choices[0];

      // LocalAI hack/workaround, until https://github.com/go-skynet/LocalAI/issues/788 is fixed
      if (finish_reason === undefined)
        finish_reason = 'stop';

      // check for a function output
      // NOTE: this includes a workaround for when we requested a function but the model could not deliver
      return (finish_reason === 'function_call' || 'function_call' in message)
        ? parseChatGenerateFCOutput(isFunctionsCall, message as OpenAIWire.ChatCompletion.ResponseFunctionCall)
        : parseChatGenerateOutput(message as OpenAIWire.ChatCompletion.ResponseMessage, finish_reason);
    }),

  /* [OpenAI] images/generations */
  createImages: publicProcedure
    .input(createImagesInputSchema)
    .output(t2iCreateImagesOutputSchema)
    .mutation(async ({ input: { access, request } }) => {

      // Validate input
      if (request.model === 'dall-e-3' && request.count > 1)
        throw new TRPCError({ code: 'BAD_REQUEST', message: `[OpenAI Issue] dall-e-3 model does not support more than 1 image` });

      // create 1 image (dall-e-3 won't support more than 1, so better transfer the burden to the client)
      const wireOpenAICreateImageOutput = await openaiPOST<WireOpenAICreateImageOutput, WireOpenAICreateImageRequest>(
        access, null,
        {
          prompt: request.prompt,
          model: request.model,
          n: request.count,
          quality: request.quality,
          response_format: request.asUrl ? 'url' : 'b64_json',
          size: request.size,
          style: request.style,
          user: 'big-agi',
        },
        '/v1/images/generations',
      );

      // expect a single image and as URL
      const imagesOutput = wireOpenAICreateImageOutputSchema.parse(wireOpenAICreateImageOutput);
      return imagesOutput.data.map(image => {
        if ('b64_json' in image)
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `[OpenAI Issue] Expected a url, got a b64_json (which is not implemented yet)` });
        return {
          imageUrl: image.url,
          altText: image.revised_prompt || request.prompt,
        };
      });
    }),

  /* [OpenAI] check for content policy violations */
  moderation: publicProcedure
    .input(moderationInputSchema)
    .mutation(async ({ input: { access, text } }): Promise<OpenAIWire.Moderation.Response> => {
      try {

        return await openaiPOST<OpenAIWire.Moderation.Response, OpenAIWire.Moderation.Request>(access, null, {
          input: text,
          model: 'text-moderation-latest',
        }, '/v1/moderations');

      } catch (error: any) {
        if (error.code === 'ECONNRESET')
          throw new TRPCError({ code: 'CLIENT_CLOSED_REQUEST', message: 'Connection reset by the client.' });

        console.error('api/openai/moderation error:', error);
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Error: ${error?.message || error?.toString() || 'Unknown error'}` });
      }
    }),

});


const DEFAULT_HELICONE_OPENAI_HOST = 'oai.hconeai.com';
const DEFAULT_MISTRAL_HOST = 'https://api.mistral.ai';
const DEFAULT_OPENAI_HOST = 'api.openai.com';
const DEFAULT_OPENROUTER_HOST = 'https://openrouter.ai/api';
const DEFAULT_TOGETHERAI_HOST = 'https://api.together.xyz';

export function openAIAccess(access: OpenAIAccessSchema, modelRefId: string | null, apiPath: string): { headers: HeadersInit, url: string } {
  switch (access.dialect) {

    case 'azure':
      const azureKey = access.oaiKey || env.AZURE_OPENAI_API_KEY || '';
      const azureHost = fixupHost(access.oaiHost || env.AZURE_OPENAI_API_ENDPOINT || '', apiPath);
      if (!azureKey || !azureHost)
        throw new Error('Missing Azure API Key or Host. Add it on the UI (Models Setup) or server side (your deployment).');

      let url = azureHost;
      if (apiPath.startsWith('/v1/')) {
        if (!modelRefId)
          throw new Error('Azure OpenAI API needs a deployment id');
        url += `/openai/deployments/${modelRefId}/${apiPath.replace('/v1/', '')}?api-version=2023-07-01-preview`;
      } else if (apiPath.startsWith('/openai/deployments'))
        url += apiPath;
      else
        throw new Error('Azure OpenAI API path not supported: ' + apiPath);

      return {
        headers: {
          'Content-Type': 'application/json',
          'api-key': azureKey,
        },
        url,
      };


    case 'lmstudio':
    case 'localai':
    case 'oobabooga':
    case 'openai':
      const oaiKey = access.defaultCheck ? (env.OPENAI_API_KEY || '') : (access.oaiKey || '');
      const oaiOrg = access.oaiOrg || env.OPENAI_API_ORG_ID || '';
      let oaiHost = fixupHost(access.oaiHost || env.OPENAI_API_HOST || DEFAULT_OPENAI_HOST, apiPath);
      // warn if no key - only for default (non-overridden) hosts
      if (!oaiKey && oaiHost.indexOf(DEFAULT_OPENAI_HOST) !== -1)
        throw new Error('Missing OpenAI API Key. Add it on the UI (Models Setup) or use default system api key.');

      // [Helicone]
      // We don't change the host (as we do on Anthropic's), as we expect the user to have a custom host.
      let heliKey = access.heliKey || env.HELICONE_API_KEY || false;
      if (heliKey) {
        if (oaiHost.includes(DEFAULT_OPENAI_HOST)) {
          oaiHost = `https://${DEFAULT_HELICONE_OPENAI_HOST}`;
        } else if (!oaiHost.includes(DEFAULT_HELICONE_OPENAI_HOST)) {
          // throw new Error(`The Helicone OpenAI Key has been provided, but the host is not set to https://${DEFAULT_HELICONE_OPENAI_HOST}. Please fix it in the Models Setup page.`);
          heliKey = false;
        }
      }

      // [Cloudflare OpenAI AI Gateway support]
      // Adapts the API path when using a 'universal' or 'openai' Cloudflare AI Gateway endpoint in the "API Host" field
      if (oaiHost.includes('https://gateway.ai.cloudflare.com')) {
        const parsedUrl = new URL(oaiHost);
        const pathSegments = parsedUrl.pathname.split('/').filter(segment => segment.length > 0);

        // The expected path should be: /v1/<ACCOUNT_TAG>/<GATEWAY_URL_SLUG>/<PROVIDER_ENDPOINT>
        if (pathSegments.length < 3 || pathSegments.length > 4 || pathSegments[0] !== 'v1')
          throw new Error('Cloudflare AI Gateway API Host is not valid. Please check the API Host field in the Models Setup page.');

        const [_v1, accountTag, gatewayName, provider] = pathSegments;
        if (provider && provider !== 'openai')
          throw new Error('Cloudflare AI Gateway only supports OpenAI as a provider.');

        if (apiPath.startsWith('/v1'))
          apiPath = apiPath.replace('/v1', '');

        oaiHost = 'https://gateway.ai.cloudflare.com';
        apiPath = `/v1/${accountTag}/${gatewayName}/${provider || 'openai'}${apiPath}`;
      }

      return {
        headers: {
          'Content-Type': 'application/json',
          ...(oaiKey && { Authorization: `Bearer ${oaiKey}` }),
          ...(oaiOrg && { 'OpenAI-Organization': oaiOrg }),
          ...(heliKey && { 'Helicone-Auth': `Bearer ${heliKey}` }),
        },
        url: oaiHost + apiPath,
      };


    case 'mistral':
      // https://docs.mistral.ai/platform/client
      const mistralKey = access.oaiKey || env.MISTRAL_API_KEY || '';
      const mistralHost = fixupHost(access.oaiHost || DEFAULT_MISTRAL_HOST, apiPath);
      return {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${mistralKey}`,
        },
        url: mistralHost + apiPath,
      };


    case 'openrouter':
      const orKey = access.defaultCheck ? (env.OPENROUTER_API_KEY || '') : (access.oaiKey || '');
      const orHost = fixupHost(access.oaiHost || DEFAULT_OPENROUTER_HOST, apiPath);
      if (!orKey || !orHost)
        throw new Error('Missing OpenRouter API Key or Host. Add it on the UI (Models Setup) or use default system api key.');

      return {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${orKey}`,
          'HTTP-Referer': Brand.URIs.Home,
          'X-Title': Brand.Title.Base,
        },
        url: orHost + apiPath,
      };

    case 'togetherai':
      const togetherKey = access.oaiKey || env.TOGETHERAI_API_KEY || '';
      const togetherHost = fixupHost(access.oaiHost || DEFAULT_TOGETHERAI_HOST, apiPath);
      if (!togetherKey || !togetherHost)
        throw new Error('Missing TogetherAI API Key or Host. Add it on the UI (Models Setup) or server side (your deployment).');

      return {
        headers: {
          'Authorization': `Bearer ${togetherKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        url: togetherHost + apiPath,
      };

  }
}

export function openAIChatCompletionPayload(model: OpenAIModelSchema, history: OpenAIHistorySchema, functions: OpenAIFunctionsSchema | null, forceFunctionName: string | null, n: number, stream: boolean): OpenAIWire.ChatCompletion.Request {
  return {
    model: model.id,
    messages: history,
    ...(functions && { functions: functions, function_call: forceFunctionName ? { name: forceFunctionName } : 'auto' }),
    ...(model.temperature && { temperature: model.temperature }),
    ...(model.maxTokens && { max_tokens: model.maxTokens }),
    ...(n > 1 && { n }),
    stream,
  };
}

async function openaiGET<TOut extends object>(access: OpenAIAccessSchema, apiPath: string /*, signal?: AbortSignal*/): Promise<TOut> {
  const { headers, url } = openAIAccess(access, null, apiPath);
  return await fetchJsonOrTRPCError<TOut>(url, 'GET', headers, undefined, `OpenAI/${access.dialect}`);
}

async function openaiPOST<TOut extends object, TPostBody extends object>(access: OpenAIAccessSchema, modelRefId: string | null, body: TPostBody, apiPath: string /*, signal?: AbortSignal*/): Promise<TOut> {
  const { headers, url } = openAIAccess(access, modelRefId, apiPath);
  return await fetchJsonOrTRPCError<TOut, TPostBody>(url, 'POST', headers, body, `OpenAI/${access.dialect}`);
}

function parseChatGenerateFCOutput(isFunctionsCall: boolean, message: OpenAIWire.ChatCompletion.ResponseFunctionCall) {
  // NOTE: Defensive: we run extensive validation because the API is not well tested and documented at the moment
  if (!isFunctionsCall)
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `[OpenAI Issue] Received a function call without a function call request`,
    });

  // parse the function call
  const fcMessage = message as any as OpenAIWire.ChatCompletion.ResponseFunctionCall;
  if (fcMessage.content !== null)
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `[OpenAI Issue] Expected a function call, got a message`,
    });

  // got a function call, so parse it
  const fc = fcMessage.function_call;
  if (!fc || !fc.name || !fc.arguments)
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `[OpenAI Issue] Issue with the function call, missing name or arguments`,
    });

  // decode the function call
  const fcName = fc.name;
  let fcArgs: object;
  try {
    fcArgs = JSON.parse(fc.arguments);
  } catch (error: any) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `[OpenAI Issue] Issue with the function call, arguments are not valid JSON`,
    });
  }

  return {
    function_name: fcName,
    function_arguments: fcArgs,
  };
}

function parseChatGenerateOutput(message: OpenAIWire.ChatCompletion.ResponseMessage, finish_reason: 'stop' | 'length' | null) {
  // validate the message
  if (message.content === null)
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `[OpenAI Issue] Expected a message, got a null message`,
    });

  return {
    role: message.role,
    content: message.content,
    finish_reason: finish_reason,
  };
}