---
title: AI model provider service for Backstage
status: implementable
authors:
  - '@pguppy'
owners:
  - '@backstage/maintainers'
project-areas:
  - core
creation-date: 2026-04-14
---

# BEP: AI model service for Backstage

- [Summary](#summary)
- [Motivation](#motivation)
- [Goals](#goals)
- [Non-goals](#non-goals)
- [Proposal](#proposal)
- [Design details](#design-details)
- [Why service-first](#why-service-first)
- [Why AI SDK](#why-ai-sdk)
- [Release plan](#release-plan)
- [Dependencies](#dependencies)
- [Alternatives](#alternatives)

## Summary

This BEP proposes a new **core AI model provder service** for Backstage.

The service gives backend plugins and other backend features a single, provider-agnostic way to access AI model capabilities such as:

- text generation
- structured output
- embeddings
- image generation
- speech generation
- transcription
- video generation

The immediate implementation focus is the **model plane** only: provider abstraction, model selection, capability gates, configuration, and a stable service surface for consumers.

This BEP is intentionally narrow. It does **not** attempt to solve the entire future Backstage AI platform. Tool execution, context retrieval, approvals, and broader agent runtime concerns are important, but they are future work. They are mentioned only to explain where this service fits in the bigger picture.

## Motivation

Backstage does not currently provide a standard way for backend features to consume AI capabilities.

Today, if a plugin author wants to add AI to a Backstage feature, they typically need to:

1. choose a specific provider.
2. wire provider authentication and SDK calls themselves.
3. define their own config shape.
4. handle provider-specific error handling, model selection, and capability support.

This leads to repeated implementation across plugins, fragmented credentials, and provider lock-in at the wrong layer.

Backstage needs a framework-level model service so that plugin authors can depend on a stable Backstage contract instead of vendor SDKs directly.

The service should make the following possible:

- operators configure providers in one place.
- backend features call a stable Backstage API.
- providers can be swapped without changing consumer code.
- capabilities are enabled explicitly and predictably.
- future AI features in Backstage have a common model-access foundation.

### Goals

- **Create a new core AI model service** for backend consumers.
- **Make service-first consumption the primary model** for AI access in the backend system.
- **Keep the Backstage framework contract Backstage-owned**, even if the default implementation uses AI SDK internally.
- **Provide provider abstraction** so consumers do not depend on vendor SDKs directly.
- **Centralize provider configuration** under a single config surface.
- **Support extensibility through service-based provider factory contributions**, not plugin-owned extension points.
- **Keep the built-in provider surface small**, with only a small set of core provider families in the framework.
- **Use explicit capability gates** so no capability is silently enabled.
- **Expose a clear model API** that is easy for plugin authors and maintainers to understand.
- **Keep the first implementation narrow** and focused on model access only.

### Non-goals

- **No general-purpose agent framework.**
- **No tool registry.**
- **No context retrieval or Retrieval-Augmented Generation (RAG) framework.**
- **No run-state or workflow engine.**
- **No shared framework registry.**
- **No multi-tenant provider selection.**
- **No plugin-owned provider registry.**
- **No requirement to choose a single external orchestration runtime.**

Those concerns belong to the broader Backstage AI platform discussion, but they are not part of what this BEP asks Backstage to implement first.

## Proposal

Introduce a new core AI model service in the Backstage backend system.

At a high level, the service will provide:

- a provider-agnostic API for model capabilities.
- a standard config model for provider credentials and defaults.
- a service-based provider family contribution mechanism using multiton service refs.
- a stable surface for backend consumers to depend on.
- a small set of built-in provider families in core.
- an optional HTTP facade later for frontend and remote consumers.

### Proposed shape

The proposal has five parts:

1. **Core service contract.** A Backstage-native service for AI model access.

2. **Provider family contribution model.** A typed provider factory contract contributed through the backend service system.

3. **Configuration model.** A single `ai.providers.*` config surface for operators.

4. **Capability gates and startup validation.** Capabilities are unavailable unless explicitly configured, and invalid provider configuration fails clearly.

5. **Optional facade.** If Backstage later needs frontend or remote access, it can add a thin HTTP layer on top of the service. That facade should not own provider registration or extensibility.

### Broader context

Backstage AI will likely grow into a broader platform over time. That broader direction includes tools, context, and governance, but this BEP only proposes the model-access layer that those capabilities would later build on.

## Design details

### Why service-first

This proposal should follow the existing Backstage backend service model rather than introducing a plugin-owned registry.

Backstage already has a proven pattern for extensible core services:

- define the consumer-facing service ref in `@backstage/backend-plugin-api`.
- provide the default implementation in `@backstage/backend-defaults`.
- use a `multiton` service ref for additive contributions.
- aggregate built-ins and adopter-supplied contributions in one service factory.

The URL reader and auth systems already use this pattern successfully.

This is a better fit than plugin extension points because extension points are plugin-scoped, while this proposal needs a cross-cutting framework service that any backend feature can consume.

At a high level, the model plane should look like this:

- `coreServices.aiModels` is the primary backend consumption surface.
- `aiProviderFactoriesServiceRef` is a multiton contribution point for provider family factories.
- `aiModelsServiceFactory` in `@backstage/backend-defaults` aggregates built-in and user-supplied provider factories.
- adopters add custom providers with `backend.add(createServiceFactory(...))`.
- an HTTP API, if needed later, sits on top of the service rather than owning the extensibility model.

### Why AI SDK

This proposal explicitly asks Backstage to align the AI model service with the AI Software Development Kit (SDK) provider ecosystem.

More specifically:

- use `@ai-sdk/provider` as the provider protocol contract exposed by provider implementations.
- use the `ai` package internally for model operations such as `generateText`, `streamText`, `embed`, `generateImage`, and related capabilities.
- use first-party `@ai-sdk/*` provider packages where appropriate.
- use `@ai-sdk/openai-compatible` for the large set of providers that expose OpenAI-style endpoints.

This does **not** mean Backstage is adopting the full AI SDK product surface as a framework opinion.

It means:

- Backstage uses AI SDK as the default internal model and provider implementation layer.
- Backstage keeps its own service contract and config model.
- Backstage does not expose raw AI SDK types as the primary framework API.
- Backstage remains free to integrate with different orchestration runtime environments above that layer.

#### Why this is a strong fit

1. **Provider standardization.** AI SDK already provides a common contract across a very large provider ecosystem. That is exactly the problem this service needs to solve first.

2. **Good TypeScript fit.** AI SDK is strongly aligned with the TypeScript and Node.js ecosystem that Backstage already uses.

3. **Broad provider coverage.** AI SDK has first-party support for major providers and a clear OpenAI-compatible path for the long tail. This lets Backstage avoid building and maintaining provider integrations from scratch.

4. **Capability alignment.** AI SDK already has primitives for generation, streaming, structured output, embeddings, image generation, speech, transcription, and experimental video. That maps well to the capabilities this service wants to expose.

5. **Clear path for custom endpoints.** AI SDK provider packages support configurable provider instances and compatibility layers, which makes it practical to support internal proxies and custom endpoints without inventing a separate provider framework.

6. **Reduces maintenance burden.** Backstage should not spend its effort reimplementing every vendor transport and model capability when a strong provider abstraction already exists.

7. **Runtime interoperability.** AI SDK is already a natural fit for TypeScript runtimes such as Mastra. Using AI SDK behind the Backstage service creates a cleaner bridge into those runtimes without making them part of the framework contract.

#### What this means for Backstage

Choosing AI SDK here means Backstage is making a deliberate trade:

- **Backstage owns**

  - the service contract.
  - config shape.
  - provider family policy.
  - capability gating.
  - startup validation.
  - how backend features consume the service.
  - any advanced runtime-resolution method or reference integrations that Backstage chooses to expose.

- **AI SDK provides**
  - provider protocol types.
  - provider implementations.
  - multi-capability model primitives.
  - compatibility helpers for the provider ecosystem.

This keeps the Backstage-specific logic in Backstage while avoiding reinvention at the provider layer.

### Public contract and implementation boundary

The most important architectural boundary is that `AIModelsService` remains the public Backstage framework contract.

Backstage consumers should code against Backstage request and response types, not raw AI SDK model instances or provider types.

The default implementation can still use AI SDK internally to:

- resolve provider instances from config.
- create model primitives for generation, embeddings, and streaming.
- interoperate with runtimes that already understand AI SDK concepts through advanced methods on the same service.

This gives Backstage the benefits of AI SDK without coupling the long-term framework API directly to AI SDK surface area.

### Core service

The primary thing this BEP asks Backstage to introduce is a new core AI model service for backend consumers.

The service should let consumers do things like:

```ts
type AIResolvableModelCapability = 'text-generation' | 'embeddings';

interface ResolveModelRequest<
  TCapability extends AIResolvableModelCapability = AIResolvableModelCapability,
> {
  capability: TCapability;
  provider?: string;
  model?: string;
}

type ResolvedModel<TCapability extends AIResolvableModelCapability> =
  TCapability extends 'embeddings' ? EmbeddingModel<string> : LanguageModel;

interface AIModelsService {
  /**
   * Generates text using the resolved provider instance and model selection policy.
   *
   * @param request - The text-generation request, including prompt, optional provider selection, and model options.
   * @returns The generated text response and any associated provider metadata exposed by the service contract.
   */
  generateText(request: GenerateTextRequest): Promise<GenerateTextResponse>;

  /**
   * Streams text output using the same provider resolution and capability-gating rules as `generateText`.
   *
   * @param request - The streaming text-generation request.
   * @returns An async iterable that yields streamed text output from the resolved model.
   */
  streamText(request: StreamTextRequest): AsyncIterable<string>;

  /**
   * Generates structured output validated against the caller-provided schema or type contract.
   *
   * @param request - The structured-generation request, including schema and prompt or input content.
   * @returns A structured response whose payload conforms to the requested output shape.
   */
  generateObject<T>(
    request: GenerateObjectRequest<T>,
  ): Promise<GenerateObjectResponse<T>>;

  /**
   * Generates embeddings for the supplied input using an embeddings-capable model.
   *
   * @param request - The embedding request, including the input value or values to embed.
   * @returns The embedding response produced by the resolved embeddings-capable model.
   */
  embed(request: EmbedRequest): Promise<EmbedResponse>;

  /**
   * Generates images when the resolved provider instance supports image generation.
   *
   * @param request - The image-generation request.
   * @returns The generated image response from the resolved image-capable model.
   */
  generateImage?(request: GenerateImageRequest): Promise<GenerateImageResponse>;

  /**
   * Generates speech audio when the resolved provider instance supports speech synthesis.
   *
   * @param request - The speech-generation request.
   * @returns The generated speech response, such as audio content or a provider-specific output reference.
   */
  generateSpeech?(
    request: GenerateSpeechRequest,
  ): Promise<GenerateSpeechResponse>;

  /**
   * Transcribes audio when the resolved provider instance supports transcription.
   *
   * @param request - The transcription request, including the audio input to process.
   * @returns The transcription response produced by the resolved transcription-capable model.
   */
  transcribe?(request: TranscribeRequest): Promise<TranscribeResponse>;

  /**
   * Generates video when the resolved provider instance supports video generation.
   *
   * @param request - The video-generation request.
   * @returns The generated video response from the resolved video-capable model.
   */
  generateVideo?(request: GenerateVideoRequest): Promise<GenerateVideoResponse>;

  /**
   * Resolves an AI SDK-compatible model for advanced runtime integration.
   *
   * This is an advanced method intended for runtimes such as Mastra/LangGraph. Ordinary
   * Backstage consumers should prefer the Backstage-owned request/response methods above.
   *
   * @param options - Provider, model, and capability selection used to resolve the model object.
   * @returns An AI SDK-compatible model instance suitable for advanced runtime injection.
   */
  resolveModel?<TCapability extends AIResolvableModelCapability>(
    options: ResolveModelRequest<TCapability>,
  ): Promise<ResolvedModel<TCapability>>;
}
```

This surface should be provider-agnostic. Consumer code should not need to know whether the operator configured OpenAI, Anthropic, Google, Bedrock, or another compatible provider.

Requests may optionally name a provider instance and model. Otherwise, the service resolves them from the configured defaults under `ai.providers.*`.

Provider instances are **not** one-model bindings. A single provider instance may expose multiple models for the same capability, such as several text-generation models behind one OpenAI or Google provider instance.

The resolution rules should be:

- if `provider` and `model` are supplied, use that exact model on that provider instance.
- if `provider` is supplied and `model` is omitted, use that provider instance's default model for the requested capability.
- if both are omitted, use `ai.defaultProvider` and that provider instance's default model for the requested capability.
- if `model` is supplied and `provider` is omitted, resolve the model within the default provider instance only. Callers that want a non-default provider must name it explicitly.

The service contract should stay stable even if the internal AI SDK integration evolves over time. If runtime-oriented AI SDK-compatible interop is added, it should remain a clearly documented advanced method on the same service rather than becoming the primary ordinary usage path.

### Provider family contribution model

Provider implementations should be extensible through the backend service system.

Each provider family contribution should:

- expose provider family metadata.
- create configured provider instances from `ai.providers.<instance>`.
- declare supported capabilities.
- perform health checks.
- support lifecycle cleanup if needed.

At a high level:

```ts
export const aiProviderFactoriesServiceRef =
  createServiceRef<AIProviderFactory>({
    id: 'core.ai.providerFactories',
    multiton: true,
  });

interface AIProviderFactory {
  readonly type: string;
  create(options: AIProviderFactoryOptions): Promise<AIProvider>;
}

interface AIProvider {
  readonly metadata: AIProviderMetadata;
  supports(capability: AICapabilityType): boolean;
  getLanguageModelFactory(): LanguageModelFactory;
  getEmbeddingModelFactory?(): EmbeddingModelFactory;
  getImageModelFactory?(): ImageModelFactory;
  getSpeechModelFactory?(): SpeechModelFactory;
  getTranscriptionModelFactory?(): TranscriptionModelFactory;
  getVideoModelFactory?(): VideoModelFactory;
  healthCheck(): Promise<{
    healthy: boolean;
    message?: string;
    latency?: number;
  }>;
  dispose?(): Promise<void>;
}
```

The intent is:

- `@backstage/backend-plugin-api` owns the consumer-facing service contract.
- `@backstage/backend-defaults` owns the default implementation and the provider factory aggregation logic.
- built-in provider families live in the default implementation.
- adopters and community packages can add more provider families by contributing additional `AIProviderFactory` implementations.
- operators enable provider instances through config.

For example, a custom provider contribution would look like this:

```ts
const customProviderFactory = createServiceFactory({
  service: aiProviderFactoriesServiceRef,
  deps: {},
  async factory() {
    return myCustomProviderFamilyFactory;
  },
});

backend.add(customProviderFactory);
```

This keeps provider extensibility open without making the AI service itself a plugin-owned extension surface.

### Runtime interop

Using AI SDK internally also gives Backstage a cleaner interop story with TypeScript AI runtimes that already understand AI SDK model semantics.

The clearest immediate example is Mastra. Backstage should be able to expose a single advanced `resolveModel(...)` method on `AIModelsService` that returns AI SDK-compatible model objects for runtime injection, without forcing ordinary backend plugins to consume AI SDK directly.

That is a strong reason to use AI SDK under the hood. It is **not** a reason to make AI SDK the only or primary ordinary usage pattern of the public framework API.

### Configuration

All provider configuration should live under a single `ai` root key in `app-config.yaml`.

The `type` field is always required and identifies the provider family factory to use. The `defaultProvider` key refers to a provider instance key, not a family name.

Example:

```yaml
ai:
  defaultProvider: openai
  providers:
    openai:
      type: openai
      apiKey: ${OPENAI_API_KEY}
      defaultModels:
        text-generation: gpt-4o
        embeddings: text-embedding-3-large
      modelAliases:
        text-generation:
          fast: gpt-4.1-mini
          flagship: gpt-4.1
          reasoning: o4-mini

    gemini:
      type: google
      apiKey: ${GOOGLE_API_KEY}
      defaultModels:
        text-generation: gemini-2.5-pro
      modelAliases:
        text-generation:
          fast: gemini-2.5-flash
          flagship: gemini-2.5-pro
```

This gives operators one place to manage credentials, model defaults, optional model aliases, and provider configuration.

The important rule is that `defaultModels` selects the fallback model for each capability. It does **not** mean a provider instance can only use one model for that capability.

For example, all of the following should be valid:

```ts
await aiModels.generateText({
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  prompt: 'Summarize this document',
});

await aiModels.generateText({
  provider: 'openai',
  model: 'o4-mini',
  prompt: 'Think through this migration plan',
});

await aiModels.resolveModel({
  capability: 'text-generation',
  provider: 'openai',
  model: 'gpt-4.1-mini',
});
```

`model` may be either a concrete upstream model ID or an operator-defined alias if the selected provider instance exposes aliases.

### Custom endpoints and provider families

Provider family contributions should be organized by **protocol and authentication family**, not by every model vendor name that may appear in the ecosystem.

That distinction matters because a model brand and a provider transport are not always the same thing.

Examples:

- a Claude model called through the Anthropic Messages API belongs to the **Anthropic** provider family.
- a Claude model called through Amazon Bedrock belongs to the **Bedrock** provider family.
- a model served through an OpenAI-compatible endpoint belongs to the **OpenAI-compatible** provider family.

To avoid ambiguity, Backstage should treat these as separate concerns:

- **model vendor**: who built the model, for example Anthropic.
- **provider family**: which API, auth model, and control plane Backstage uses to reach the model.
- **SDK compatibility**: whether a client library can speak to that endpoint shape.

SDK compatibility does not change provider identity. A Bedrock-hosted Claude deployment may be accessible through Anthropic-oriented client support, but it still belongs to the **Bedrock** provider family because the request is governed by Bedrock auth, regions, model IDs, quotas, and control plane behavior.

This means custom endpoints should work like this:

- the **Anthropic** provider family can support a custom `baseURL` for proxy or private Anthropic-compatible Anthropic Messages API endpoints.
- the **Bedrock** provider family can support a custom `baseURL` for Bedrock proxy or custom Bedrock endpoints.
- the **OpenAI-compatible** path can support arbitrary `baseURL`, headers, and query parameters for the long tail of OpenAI-style providers.

If an operator has an internal endpoint that exposes the Anthropic API shape, that is configured as an Anthropic provider instance with a custom endpoint.

If an operator is using Claude through Bedrock, that is configured as a Bedrock provider instance, even though the underlying model vendor is Anthropic and some SDK layers may offer compatible calling patterns.

The core rule is:

> Provider identity in Backstage should follow the request protocol, auth model, and control plane, not only the model vendor name or SDK compatibility.

### Capability gates and startup validation

Capabilities should only be enabled when explicitly configured.

For example:

- if `text-generation` is not configured for a provider, text generation is unavailable on that provider.
- if `embeddings` is not configured, embedding calls fail with a clear error.

In addition, the default implementation should validate startup-time misconfiguration and fail clearly for cases such as:

- duplicate provider family factory `type` values.
- unknown provider family `type` values in config.
- an `ai.defaultProvider` that does not point to a configured provider instance.

This avoids hidden defaults, surprise cost, accidental capability exposure, and ambiguous provider resolution.

### Provider packaging strategy

The initial provider plan should stay deliberately small.

Core should include only a limited set of provider families:

- OpenAI.
- Anthropic.
- Google.
- Bedrock.
- an OpenAI-compatible path for the long tail of providers.

The purpose of the OpenAI-compatible path is to avoid adding one integration package per vendor when the provider can already be configured through a common compatibility layer.

For the first implementation, these core provider families should live in the default AI service implementation in `@backstage/backend-defaults`, following the same general pattern as built-in URL readers.

This proposal should scale to the large number of AI SDK providers by dividing them into three buckets:

1. **First-class core provider families.** Providers with distinct protocol or auth requirements that justify dedicated support in the default service implementation.

2. **Config-defined OpenAI-compatible instances.** Providers that can be expressed through a shared OpenAI-compatible implementation by supplying `baseURL`, credentials, headers, and model defaults.

3. **Community or adopter-supplied provider families.** Providers that do not fit the above categories or are too niche to justify inclusion in core.

This avoids a future where Backstage needs to maintain a separate core package or module for every provider listed in the AI SDK ecosystem.

If dependency footprint or optional loading becomes a concern later, built-in provider families can be split behind feature loaders without changing the service contract.

### Example configuration shape

```yaml
ai:
  providers:
    anthropic:
      type: anthropic
      apiKey: ${ANTHROPIC_API_KEY}
      baseURL: https://api.anthropic.com/v1
      defaultModels:
        text-generation: claude-sonnet-4-5

    anthropic:
      type: anthropic
      apiKey: ${ANTHROPIC_API_KEY}
      baseURL: https://anthropic.internal/v1
      defaultModels:
        text-generation: claude-sonnet-4-5

    bedrock:
      type: bedrock
      region: us-east-1
      defaultModels:
        text-generation: us.anthropic.claude-sonnet-4-5-20250929-v1:0

    groq:
      type: openai-compatible
      baseURL: https://api.groq.com/openai/v1
      apiKey: ${GROQ_API_KEY}
      defaultModels:
        text-generation: llama-3.3-70b-versatile
```

In this model:

- config keys such as `anthropic` or `groq` are **provider instances**.
- `type` identifies the **provider family factory**.
- model IDs remain provider-specific.
- the number of built-in Backstage provider families stays small even if the number of configured provider instances grows.

### Consumer access patterns

This BEP is centered on the new core service for backend consumers.

Backend consumers should depend on `coreServices.aiModels`. An HTTP facade may also be provided later for frontend consumers and remote callers, but that is secondary to the service contract itself. The core proposal is that Backstage backend features should be able to depend on a stable AI model service the same way they depend on other framework services.

### Scope control

This BEP intentionally stops at model access.

It does not define:

- how AI tools are discovered or executed.
- how context is assembled.
- how long-running runs are modeled.
- how approvals are implemented.
- how a full agent runtime should work.

Those topics should be discussed separately once the model service exists.

## Release plan

### Initial implementation

The first implementation should include:

- the core AI models service contract in `@backstage/backend-plugin-api`, likely alpha first.
- the default service implementation and provider contribution ref in `@backstage/backend-defaults`.
- a configuration model under `ai.providers.*`.
- capability gates and startup validation.
- a small initial provider family set.
- health and readiness support.
- permission boundaries appropriate for model capabilities.

An HTTP facade should be added only if there is a clear immediate use case for frontend or remote consumers.

### Follow-up work

After the model service lands, follow-up design and implementation work can expand into:

- tools.
- context.
- governance.
- runtime integrations.

These are deliberately not part of the initial BEP scope.

## Dependencies

- [`@ai-sdk/provider`](https://github.com/vercel/ai/tree/main/packages/provider) for provider protocol types.
- [`ai`](https://www.npmjs.com/package/ai) for model runtime primitives where needed.
- first-party `@ai-sdk/*` provider packages for dedicated provider family integrations in core.
- [`@ai-sdk/openai-compatible`](https://ai-sdk.dev/providers/openai-compatible-providers) for the large set of OpenAI-style providers.
- Backstage backend service system primitives, including service refs, default service factories, and multiton contributions.
- Backstage feature loaders if optional provider loading is needed later.

## Alternatives

### Use AI SDK as proposed

#### Pros

- large provider ecosystem available immediately.
- strong TypeScript and Node.js fit.
- built-in support for multiple model capabilities.
- clear custom-endpoint story through provider instances and compatibility packages.
- reduces the amount of provider-specific code Backstage must own.
- gives Backstage a cleaner path to runtime interoperability with Mastra and other TypeScript runtimes that already align with AI SDK.

#### Cons

- introduces a meaningful external dependency into a framework-level feature.
- Backstage becomes partially coupled to the AI SDK provider contract.
- upstream breaking changes in AI SDK may require coordination in Backstage.
- not every provider supports every capability uniformly, so Backstage still needs clear capability and packaging policy.
- if AI SDK types leak into the public service contract, Backstage would take on avoidable API coupling.

### Plugin-owned extension points and backend modules

Backstage could model providers as contributions to a dedicated AI backend plugin through plugin extension points and backend modules.

#### Pros

- familiar contribution shape for plugin-local extensibility.
- easy to imagine as a standalone plugin package.

#### Cons

- extension points are plugin-scoped rather than a general core service extensibility mechanism.
- provider registration becomes owned by a plugin runtime surface instead of a framework service.
- it does not match the established service-first patterns Backstage already uses for extensible core services such as URL readers and auth handlers.

### Per-plugin provider integrations

Each plugin manages its own provider SDK and config directly.

This is the current default approach, but it does not scale well and creates provider-specific coupling across the ecosystem.

### Define a Backstage-owned provider abstraction with no AI SDK dependency

Backstage could define its own provider interfaces and implement provider integrations itself.

#### Pros

- full control over the abstraction.
- no dependency on AI SDK contracts.
- Backstage fully owns the API shape and evolution.

#### Cons

- Backstage must write and maintain provider integrations itself.
- much larger implementation and maintenance burden.
- slower time to support new providers and capabilities.
- duplicates a problem that AI SDK already solves well.
- creates more friction for runtimes like Mastra that already work naturally with AI SDK semantics.

### Standardize on raw HTTP protocols only

Backstage could standardize on direct HTTP integrations, for example OpenAI-style endpoints, without using AI SDK as the abstraction layer.

#### Pros

- fewer library-level dependencies.
- transparent wire-level behavior.

#### Cons

- weak fit for non-OpenAI protocol families.
- more vendor-specific implementation burden in Backstage.
- harder to support the range of capabilities and providers consistently.

### Full agent framework first

Backstage could try to introduce a complete agent runtime before standardizing model access.

This is too broad for an initial framework change and risks mixing multiple concerns into one proposal.

### Single-provider core abstraction

Backstage could add a simple service tied to one provider.

This would be easier in the short term, but it would not meet the portability goal and would create lock-in immediately.

### HTTP facade only

Backstage could expose model access only through an HTTP API layered over a plugin or router.

That can still be useful as a facade, but it is weaker as a framework primitive than a true core service for backend consumers.

## Closing position

This BEP proposes a narrow, implementable first step for AI in the Backstage framework:

- add a new core AI model service.
- make it service-first and provider-agnostic.
- keep the service contract Backstage-owned while using AI SDK as the default provider implementation layer.
- make it extensible through multiton provider family factory contributions.
- keep the built-in provider surface deliberately small.
- make capabilities explicit through configuration.

That gives Backstage a clear and useful foundation for AI features without committing prematurely to a broader runtime design.
