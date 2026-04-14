---
title: AI Model Provider for Backstage
status: draft
authors:
  - '@pguppy'
owners:
  - '@backstage/maintainers'
project-areas:
  - core
creation-date: 2026-04-14
---

# BEP: AI Model Provider for Backstage

- [Summary](#summary)
- [Motivation](#motivation)
  - [Goals](#goals)
  - [Non-Goals](#non-goals)
- [Proposal](#proposal)
- [Design Details](#design-details)
  - [Why AI SDK](#why-ai-sdk)
- [Release Plan](#release-plan)
- [Dependencies](#dependencies)
- [Alternatives](#alternatives)

## Summary

This BEP proposes a new **core AI model provider** for Backstage.

The plugin gives backend plugins a single, provider-agnostic way to access AI model capabilities such as:

- text generation
- structured output
- embeddings
- image generation
- speech generation
- transcription
- video generation

The immediate implementation focus is the **model plane** only: provider abstraction, model selection, capability gates, configuration, and a stable service/API surface for consumers.

This BEP is intentionally narrow. It does **not** attempt to solve the entire future Backstage AI platform. Tool execution, context retrieval, approvals, and broader agent runtime concerns are important, but they are future work. They are mentioned only to explain where this service fits in the bigger picture.

## Motivation

Backstage does not currently provide a standard way for plugins to consume AI capabilities.

Today, if a plugin author wants to add AI to a Backstage feature, they typically need to:

1. choose a specific provider
2. wire provider authentication and SDK calls themselves
3. define their own config shape
4. handle provider-specific error handling, model selection, and capability support

This leads to repeated implementation across plugins, fragmented credentials, and provider lock-in at the wrong layer.

Backstage needs a framework-level model service so that plugin authors can depend on a stable Backstage contract instead of vendor SDKs directly.

The service should make the following possible:

- operators configure providers in one place
- plugins call a stable Backstage API
- providers can be swapped without changing plugin code
- capabilities are enabled explicitly and predictably
- future AI features in Backstage have a common model-access foundation

### Goals

- **Create a new core AI model service** for backend consumers
- **Provide provider abstraction** so plugins do not depend on vendor SDKs directly
- **Centralize provider configuration** under a single config surface
- **Support multiple providers** and provider-specific modules
- **Use explicit capability gates** so no capability is silently enabled
- **Expose a clear model API** that is easy for plugin authors and maintainers to understand
- **Keep the first implementation narrow** and focused on model access only

### Non-Goals

- **No general-purpose agent framework**
- **No tool registry**
- **No context retrieval or RAG framework**
- **No run-state or workflow engine**
- **No shared framework registry**
- **No multi-tenant provider selection**
- **No requirement to choose a single external orchestration runtime**

Those concerns belong to the broader Backstage AI platform discussion, but they are not part of what this BEP asks Backstage to implement first.

## Proposal

Introduce a new core AI model service in the Backstage backend system.

At a high level, the service will provide:

- a provider-agnostic API for model capabilities
- a standard config model for provider credentials and defaults
- a provider registration mechanism for pluggable provider modules
- a stable surface for backend plugins to consume
- a HTTP facade for frontend and remote consumers

### Proposed shape

The proposal has four parts:

1. **Core service contract**
   A Backstage-native service for AI model access

2. **Provider abstraction**
   A typed provider interface implemented by provider modules

3. **Configuration model**
   A single `ai.providers.*` config surface for operators

4. **Capability gating**
   Capabilities are disabled unless explicitly configured

### Broader context

Backstage AI will likely grow into a broader platform over time. That broader direction includes tools, context, and governance, but this BEP only proposes the model-access layer that those capabilities would later build on.

## Design Details

### Why AI SDK

This proposal explicitly asks Backstage to align the AI model service with the **Vercel AI SDK** provider ecosystem.

More specifically:

- use `@ai-sdk/provider` as the provider protocol contract exposed by provider implementations
- use the `ai` package internally for model operations such as `generateText`, `streamText`, `embed`, `generateImage`, and related capabilities
- use first-party `@ai-sdk/*` provider packages where appropriate
- use `@ai-sdk/openai-compatible` for the large set of providers that expose OpenAI-style endpoints

This does **not** mean Backstage is adopting the full AI SDK product surface as a framework opinion.

It means:

- Backstage uses AI SDK as the model/provider abstraction layer
- Backstage keeps its own service contract and config model
- Backstage remains free to integrate with different orchestration runtimes above that layer

#### Why this is a strong fit

1. **Provider standardization**
   AI SDK already provides a common contract across a very large provider ecosystem. That is exactly the problem this service needs to solve first.

2. **Good TypeScript fit**
   AI SDK is strongly aligned with the TypeScript and Node.js ecosystem that Backstage already uses.

3. **Broad provider coverage**
   AI SDK has first-party support for major providers and a clear OpenAI-compatible path for the long tail. This lets Backstage avoid building and maintaining provider integrations from scratch.

4. **Capability alignment**
   AI SDK already has primitives for generation, streaming, structured output, embeddings, image generation, speech, transcription, and experimental video. That maps well to the capabilities this service wants to expose.

5. **Clear path for custom endpoints**
   AI SDK provider packages support configurable provider instances and compatibility layers, which makes it practical to support internal proxies and custom endpoints without inventing a separate provider framework.

6. **Reduces maintenance burden**
   Backstage should not spend its effort reimplementing every vendor transport and model capability when a strong provider abstraction already exists.

#### What this means for Backstage

Choosing AI SDK here means Backstage is making a deliberate trade:

- **Backstage owns**
  - the service contract
  - config shape
  - provider family policy
  - capability gating
  - module packaging strategy
  - how plugins consume the service

- **AI SDK provides**
  - provider protocol types
  - provider implementations
  - multi-capability model primitives
  - compatibility helpers for the provider ecosystem

This keeps the Backstage-specific logic in Backstage while avoiding reinvention at the provider layer.

### Core service

The primary thing this BEP asks Backstage to introduce is a new core AI model service for backend plugins.

The service should let consumers do things like:

```ts
interface AIService {
  generateText(request: GenerateTextRequest): Promise<GenerateTextResponse>;
  streamText(request: StreamTextRequest): AsyncIterable<string>;
  generateObject<T>(
    request: GenerateObjectRequest<T>,
  ): Promise<GenerateObjectResponse<T>>;
  embed(request: EmbedRequest): Promise<EmbedResponse>;
  generateImage?(request: GenerateImageRequest): Promise<GenerateImageResponse>;
  generateSpeech?(request: GenerateSpeechRequest): Promise<GenerateSpeechResponse>;
  transcribe?(request: TranscribeRequest): Promise<TranscribeResponse>;
  generateVideo?(request: GenerateVideoRequest): Promise<GenerateVideoResponse>;
}
```

This surface should be provider-agnostic. Plugin authors should not need to know whether the operator configured OpenAI, Anthropic, Google, Bedrock, or another compatible provider.

### Provider abstraction

Provider implementations should be pluggable and follow the existing Backstage extensibility model.

Each provider implementation should:

- expose provider metadata
- declare supported capabilities
- create typed model factories
- perform health checks
- support lifecycle cleanup if needed

At a high level:

```ts
interface AIProvider {
  readonly metadata: AIProviderMetadata;
  initialize(config: unknown): Promise<void>;
  supports(capability: AICapabilityType): boolean;
  getLanguageModelFactory(): LanguageModelFactory;
  getEmbeddingModelFactory?(): EmbeddingModelFactory;
  getImageModelFactory?(): ImageModelFactory;
  getSpeechModelFactory?(): SpeechModelFactory;
  getTranscriptionModelFactory?(): TranscriptionModelFactory;
  getVideoModelFactory?(): VideoModelFactory;
  healthCheck(): Promise<{ healthy: boolean; message?: string; latency?: number }>;
  dispose?(): Promise<void>;
}
```

### Provider registration

Providers should be contributed through provider modules using the standard Backstage backend plugin pattern.

This is important because the model service needs to be extensible without hardcoding every provider into core.

The intent is:

- core owns the service contract and provider registry
- modules contribute providers
- operators enable providers through config

### Configuration

All provider configuration should live under a single `ai` root key in `app-config.yaml`.

Example:

```yaml
ai:
  defaultProvider: openai
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
      defaultModels:
        text-generation: gpt-4o
        embeddings: text-embedding-3-large

    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
      defaultModels:
        text-generation: claude-3-7-sonnet-latest
```

This gives operators one place to manage credentials, model defaults, and provider enablement.

### Custom endpoints and provider families

Provider modules should be organized by **protocol and authentication family**, not by every model vendor name that may appear in the ecosystem.

That distinction matters because a model brand and a provider transport are not always the same thing.

Examples:

- a Claude model called through the Anthropic Messages API belongs to the **Anthropic** provider family
- a Claude model called through Amazon Bedrock belongs to the **Bedrock** provider family
- a model served through an OpenAI-compatible endpoint belongs to the **OpenAI-compatible** provider family

To avoid ambiguity, Backstage should treat these as separate concerns:

- **model vendor** — who built the model, for example Anthropic
- **provider family** — which API, auth model, and control plane Backstage uses to reach the model
- **SDK compatibility** — whether a client library can speak to that endpoint shape

SDK compatibility does not change provider identity. A Bedrock-hosted Claude deployment may be accessible through Anthropic-oriented client support, but it still belongs to the **Bedrock** provider family because the request is governed by Bedrock auth, regions, model IDs, quotas, and control plane behavior.

This means custom endpoints should work like this:

- the **Anthropic** provider module can support a custom `baseURL` for proxy or private Anthropic-compatible Anthropic Messages API endpoints
- the **Bedrock** provider module can support a custom `baseURL` for Bedrock proxy or custom Bedrock endpoints
- the **OpenAI-compatible** path can support arbitrary `baseURL`, headers, and query parameters for the long tail of OpenAI-style providers

If an operator has an internal endpoint that exposes Anthropic's API shape, that is configured as an Anthropic provider instance with a custom endpoint.

If an operator is using Claude through Bedrock, that is configured as a Bedrock provider instance, even though the underlying model vendor is Anthropic and some SDK layers may offer compatible calling patterns.

The core rule is:

> Provider identity in Backstage should follow the request protocol, auth model, and control plane, not only the model vendor name or SDK compatibility.

### Capability gates

Capabilities should only be enabled when explicitly configured.

For example:

- if `text-generation` is not configured for a provider, text generation is unavailable on that provider
- if `embeddings` is not configured, embedding calls fail with a clear error

This avoids hidden defaults, surprise cost, and accidental capability exposure.

### Provider packaging strategy

The initial provider plan should stay deliberately small.

Core should include only a limited set of provider families:

- OpenAI
- Anthropic
- Google
- Bedrock
- an OpenAI-compatible path for the long tail of providers

The purpose of the OpenAI-compatible path is to avoid adding one module per vendor when the provider can already be configured through a common compatibility layer.

This proposal should scale to the large number of AI SDK providers by dividing them into three buckets:

1. **First-class core provider families**
   Providers with distinct protocol or auth requirements that justify a dedicated module in core.

2. **Config-defined OpenAI-compatible instances**
   Providers that can be expressed through a shared OpenAI-compatible implementation by supplying `baseURL`, credentials, headers, and model defaults.

3. **Community or custom provider packages**
   Providers that do not fit the above categories or are too niche to justify a core module.

This avoids a future where Backstage needs to maintain a separate core package for every provider listed in the AI SDK ecosystem.

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

    anthropic-proxy:
      type: anthropic
      apiKey: ${ANTHROPIC_PROXY_API_KEY}
      baseURL: https://anthropic-proxy.internal/v1
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

- config keys such as `anthropic-proxy` or `groq` are **provider instances**
- `type` identifies the **provider family implementation**
- model IDs remain provider-specific
- the number of Backstage core modules stays small even if the number of configured provider instances grows

### Consumer access patterns

This BEP is centered on the new core service for backend consumers.

An HTTP facade may also be provided for frontend consumers and remote callers, but that is secondary to the service contract itself. The core proposal is that Backstage backend plugins should be able to depend on a stable AI model service the same way they depend on other framework services.

### Scope control

This BEP intentionally stops at model access.

It does not define:

- how AI tools are discovered or executed
- how context is assembled
- how long-running runs are modeled
- how approvals are implemented
- how a full agent runtime should work

Those topics should be discussed separately once the model service exists.

## Release Plan

### Initial implementation

The first implementation should include:

- the core AI model service contract
- a provider registry
- a configuration model
- capability gates
- a small initial provider set
- health and readiness support
- permission boundaries appropriate for model capabilities

### Follow-up work

After the model service lands, follow-up design and implementation work can expand into:

- tools
- context
- governance
- runtime adapters

These are deliberately not part of the initial BEP scope.

## Dependencies

- [`@ai-sdk/provider`](https://github.com/vercel/ai/tree/main/packages/provider) for provider protocol types
- [`ai`](https://www.npmjs.com/package/ai) for model runtime primitives where needed
- first-party `@ai-sdk/*` provider packages for dedicated provider family modules
- [`@ai-sdk/openai-compatible`](https://ai-sdk.dev/providers/openai-compatible-providers) for the large set of OpenAI-style providers
- Backstage backend system primitives
- Backstage plugin/module extensibility model

## Alternatives

### Use AI SDK as proposed

#### Pros

- large provider ecosystem available immediately
- strong TypeScript and Node.js fit
- built-in support for multiple model capabilities
- clear custom-endpoint story through provider instances and compatibility packages
- reduces the amount of provider-specific code Backstage must own

#### Cons

- introduces a meaningful external dependency into a framework-level feature
- Backstage becomes partially coupled to the AI SDK provider contract
- upstream breaking changes in AI SDK may require coordination in Backstage
- not every provider supports every capability uniformly, so Backstage still needs clear capability and packaging policy

### Per-plugin provider integrations

Each plugin manages its own provider SDK and config directly.

This is the current default approach, but it does not scale well and creates provider-specific coupling across the ecosystem.

### Define a Backstage-owned provider abstraction with no AI SDK dependency

Backstage could define its own provider interfaces and implement provider integrations itself.

#### Pros

- full control over the abstraction
- no dependency on AI SDK contracts
- Backstage fully owns the API shape and evolution

#### Cons

- Backstage must write and maintain provider integrations itself
- much larger implementation and maintenance burden
- slower time to support new providers and capabilities
- duplicates a problem that AI SDK already solves well

### Standardize on raw HTTP protocols only

Backstage could standardize on direct HTTP integrations, for example OpenAI-style endpoints, without using AI SDK as the abstraction layer.

#### Pros

- fewer library-level dependencies
- transparent wire-level behavior

#### Cons

- weak fit for non-OpenAI protocol families
- more vendor-specific implementation burden in Backstage
- harder to support the range of capabilities and providers consistently

### Full agent framework first

Backstage could try to introduce a complete agent runtime before standardizing model access.

This is too broad for an initial framework change and risks mixing multiple concerns into one proposal.

### Single-provider core abstraction

Backstage could add a simple service tied to one provider.

This would be easier in the short term, but it would not meet the portability goal and would create lock-in immediately.

### No core service, plugin-only HTTP API

Backstage could expose model access only through a plugin-owned HTTP API.

That can still be useful as a facade, but it is weaker as a framework primitive than a true core service for backend consumers.

## Closing Position

This BEP proposes a narrow, implementable first step for AI in the Backstage framework:

- add a new core AI model service
- make it provider-agnostic
- align it with AI SDK as the provider abstraction layer
- make it extensible through provider modules
- make capabilities explicit through configuration

That gives Backstage a clear and useful foundation for AI features without overcommitting to a broader runtime design too early.
