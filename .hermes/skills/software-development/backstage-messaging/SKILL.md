---
name: backstage-messaging
description: "Use when working with Backstage messaging: Events (pub/sub bus), Signals (WebSocket push), and Notifications (persisted user alerts). These form a single real-time communication pipeline."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, events, signals, notifications, websocket, pubsub]
    related_skills: [backstage-plugin-blueprint, backstage-core-services]
---

# Backstage Messaging (Events → Signals → Notifications)

## Overview

Three systems forming a real-time pipeline: `Events (pub/sub) → Signals (WebSocket) → Notifications (persisted)`. 20 packages. Each system can be used independently, but together they create a complete real-time communication stack.

**Pipeline:** Something happens → Event published → Signal subscriber pushes to user's browser → Notification subscriber creates persisted alert + pushes signal for instant UI update.

## Events System (11 packages)

Backend pub/sub bus. Transport modules: `aws-sqs`, `azure`, `bitbucket-cloud`, `bitbucket-server`, `gerrit`, `github`, `gitlab`, `google-pubsub`, `kafka`.

### Publishing

```ts
await events.publish({ topic: 'my-plugin.data-changed', eventPayload: { entityRef: 'component:default/svc' } });
```

### Subscribing (via Backend Module)

```ts
import { eventsServiceRef } from '@backstage/plugin-events-node';

export const eventsModuleMySubscriber = createBackendModule({
  pluginId: 'events', moduleId: 'my-subscriber',
  register(env) {
    env.registerInit({
      deps: { events: eventsServiceRef, logger: coreServices.logger },
      async init({ events, logger }) {
        events.subscribe({
          id: 'my-subscriber',
          topics: ['my-plugin.data-changed'],
          async onEvent(params) {
            logger.info(`Event on ${params.topic}`, params.eventPayload);
          },
        });
      },
    });
  },
});
```

### EventSubscriber Interface

```ts
interface EventSubscriber {
  supportsEventTopics(): string[];
  onEvent(params: EventParams): Promise<void>;
}
interface EventParams { topic: string; eventPayload: unknown; metadata?: { userEntityRef?: string }; }
```

### Signal Recipient Types

```ts
// Target specific user:
signals.publish({ recipients: { type: 'user', entityRef: 'user:default/alice' }, channel: 'my-plugin', message: { ... } });

// Target all users (broadcast):
signals.publish({ recipients: null, channel: 'system', message: { type: 'announcement' } });
```

### Signal Channel Conventions

Use `<pluginId>` as channel name. Notifications use `'notifications'` channel. System-wide signals use `'system'`.

### Notification Recipient Types

```ts
// Send to a specific user:
notifications.send({ recipients: { type: 'user', entityRef: 'user:default/alice' }, payload: { ... } });

// Send to an entire team:
notifications.send({ recipients: { type: 'entity', entityRef: 'group:default/team-a' }, payload: { ... } });

// Broadcast to all users:
notifications.send({ recipients: { type: 'broadcast' }, payload: { ... } });
```

### Notification Processors (Custom Delivery)

Create modules that react to notifications being sent:

```ts
// notifications-backend-module-email processes notifications and sends emails
// notifications-backend-module-slack sends Slack messages
// Custom processors extend this pattern for any delivery channel
```

### HTTP Ingress (webhooks)

POST to `/api/events/http/my-plugin`. Use `HttpPostIngressEventPublisher`.

## Signals System (4 packages)

WebSocket-based real-time push to connected users. Uses Events for cross-instance distribution.

### Backend

```ts
await signals.publish({
  recipients: { type: 'user', entityRef: 'user:default/alice' },
  channel: 'my-plugin',
  message: { type: 'data-changed', payload: { entityRef } },
});
```

### Frontend

```tsx
const { lastSignal } = useSignal('my-plugin');
useEffect(() => { if (lastSignal?.type === 'data-changed') refetch(); }, [lastSignal]);
```

## Notifications System (5 packages)

Persisted user alerts with DB storage, read status tracking, and signals-based instant delivery.

### Sending

```ts
await notifications.send({
  recipients: { type: 'entity', entityRef: 'group:default/team-a' },
  payload: {
    title: 'Build Failed',
    description: 'CI build for my-service failed.',
    link: '/catalog/default/component/my-service',
    severity: 'high',
  },
});
```

### Delivery Modules

`notifications-backend-module-email` (email), `notifications-backend-module-slack` (Slack).

### Frontend

Notification bell + panel auto-installed with `@backstage/plugin-notifications`.

## Full Pipeline Example

```ts
// 1. Event: something changed
events.publish({ topic: 'catalog.entity-refresh', eventPayload: { entityRef } });

// 2. Signal subscriber → push to user
signals.publish({ recipients: { type: 'user', entityRef: owner }, channel: 'catalog', message: { type: 'refresh' } });

// 3. Notification subscriber → persisted alert + signal
notifications.send({ recipients: { type: 'entity', entityRef: ownerTeam }, payload: { title: 'Entity Refreshed', link: '/catalog/...' } });
```

## Events Bus Architecture

The events system is a pub/sub bus running inside the backend instance. Events are typed and routed by topic.

```
Producer Plugin          Events Bus          Subscriber Plugin
──────────────          ──────────          ─────────────────
catalog-backend  ────→  events bus  ────→   notifications-backend
                               ├────────→   my-audit-logger
                               └────────→   external-webhook
```

### Publishing Events

```ts
import { eventsServiceRef } from '@backstage/plugin-events-node';

env.registerInit({
  deps: { events: eventsServiceRef, ... },
  async init({ events }) {
    await events.publish({
      topic: 'catalog.entity',
      eventPayload: {
        action: 'created',
        entityRef: 'component:default/my-service',
        entity,
      },
      metadata: {
        'x-custom-header': 'value',
      },
    });
  },
});
```

### Subscribing to Events

```ts
import { eventsServiceRef } from '@backstage/plugin-events-node';

env.registerInit({
  deps: { events: eventsServiceRef, ... },
  async init({ events }) {
    events.subscribe({
      id: 'my-subscriber',
      topics: ['catalog.entity'],
      async onEvent(params) {
        const { topic, eventPayload } = params;
        console.log(`Entity ${eventPayload.action}: ${eventPayload.entityRef}`);
      },
    });
  },
});
```

### Event Topics (Common)

| Topic | Published By | Payload |
|---|---|---|
| `catalog.entity` | `catalog-backend` | `{ action, entityRef, entity }` |
| `catalog.location` | `catalog-backend` | `{ action, locationRef }` |
| `scaffolder.task` | `scaffolder-backend` | `{ taskId, status, entityRef }` |
| `signals.notification` | `notifications-backend` | `{ recipients, message }` |

## Signals Architecture (WebSocket Push)

Signals use WebSocket connections for real-time push to connected frontend clients.

```
Backend (Signal Service)  ←→  WebSocket  ←→  Frontend (Signal API)
       │
       ├── Broadcast: all connected clients
       └── Unicast: specific user's connections
```

### Sending Signals (Backend)

```ts
import { signalsServiceRef } from '@backstage/plugin-signals-node';

await signals.publish({
  recipients: { type: 'user', entityRef: 'user:default/alice' },
  channel: 'entity-updated',
  message: { entityRef: 'component:default/my-service', timestamp: Date.now() },
});

// Broadcast to all:
await signals.publish({
  recipients: { type: 'broadcast' },
  channel: 'system-alert',
  message: { text: 'Maintenance in 5 minutes' },
});
```

### Receiving Signals (Frontend)

```tsx
import { useSignal } from '@backstage/plugin-signals-react';

function EntityWatcher() {
  const { lastSignal } = useSignal('entity-updated');
  useEffect(() => {
    if (lastSignal) {
      queryClient.invalidateQueries({ queryKey: ['catalog', 'entity'] });
    }
  }, [lastSignal]);
  return null;
}
```

## Notifications Frontend

```tsx
import { useApi, notificationsApiRef } from '@backstage/core-plugin-api';

function NotificationBell() {
  const notificationsApi = useApi(notificationsApiRef);
  const { data } = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => notificationsApi.getNotifications({ read: false }),
    refetchInterval: 30_000,
  });
  return <Badge count={data?.notifications.length ?? 0} />;
}
```

### Sending Notifications (Backend)

```ts
await notifications.send({
  recipients: {
    type: 'entity',
    entityRef: 'user:default/alice',
  },
  payload: {
    title: 'Entity Updated',
    description: 'Your service was updated',
    link: '/catalog/default/component/my-service',
    severity: 'normal',      // 'normal', 'high', 'critical'
  },
});
```

## End-to-End Pipeline: Catalog Update → Signal → Notification

```ts
// 1. Catalog backend publishes event
events.publish({ topic: 'catalog.entity', eventPayload: { action: 'updated', entityRef } });

// 2. Custom subscriber reacts
events.subscribe({
  topics: ['catalog.entity'],
  async onEvent({ eventPayload }) {
    // 3. Push real-time signal to entity owner
    await signals.publish({
      recipients: { type: 'user', entityRef: getOwner(eventPayload.entity) },
      channel: 'entity-updated',
      message: { entityRef: eventPayload.entityRef },
    });

    // 4. Persist notification
    await notifications.send({
      recipients: { type: 'entity', entityRef: getOwner(eventPayload.entity) },
      payload: {
        title: 'Entity Updated',
        description: `${eventPayload.entityRef} was ${eventPayload.action}`,
        severity: 'normal',
      },
    });
  },
});
```

## Common Pitfalls

1. Events without subscribers — fire-and-forget, event lost
2. Signals to offline users — persist via notifications for offline delivery
3. Heavy event payloads — pass refs, not full objects
4. Missing signal backend — notifications need signals for instant delivery
5. No `link` in notification payload — users can't navigate to context

## Verification Checklist

- [ ] Events + transport module installed
- [ ] Signals backend installed
- [ ] Notifications backend + frontend installed
- [ ] Event payloads are lightweight (refs only)
- [ ] Notifications include navigation links
- [ ] Signal channels used consistently
