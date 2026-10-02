/**
 * Publish MCP Tools
 *
 * Tools for signing and publishing Nostr events.
 */

import { z } from 'zod';
import { finalizeEvent, getEventHash, verifyEvent } from 'nostr-tools';
import type { NostrEvent } from 'nostr-tools';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getPublishService,
  buildMetadataEvent,
  buildAMBResourceEvent,
  buildEvent,
  type AMBResourceInput,
  type AMBConcept,
  type AMBEntity,
} from '../signer/index.js';
import { getSignerManager } from './signer.js';
import { PUBLISHER } from './annotations.js';

// Default relays for publishing
const DEFAULT_RELAYS = process.env.AMB_RELAYS?.split(',') || ['wss://relay.edufeed.org'];

/**
 * Extract user ID from MCP auth context
 */
function getUserId(extra: unknown): string {
  const authInfo = (extra as { authInfo?: { clientPubkey?: string } })?.authInfo;
  return authInfo?.clientPubkey ?? 'local';
}

/**
 * Schema for concept input
 */
const conceptSchema = z.object({
  id: z.string().describe('Concept URI (e.g., from HCRT vocabulary)'),
  prefLabel: z
    .record(z.string())
    .optional()
    .describe('Localized labels (e.g., {"de": "Video", "en": "Video"})'),
});

/**
 * Schema for entity input (creator, publisher)
 */
const entitySchema = z.object({
  name: z.string().describe('Name of the person or organization'),
  type: z.string().optional().describe('Type (default: Person)'),
  id: z.string().optional().describe('URL or identifier'),
});

/**
 * Register sign_event tool
 *
 * Signs an unsigned event template using the connected signer.
 */
function registerSignEventTool(server: McpServer): void {
  server.registerTool(
    'sign_event',
    {
      title: 'Sign Event',
      description:
        'Sign an unsigned Nostr event using the connected signer. ' +
        'The signer must be connected first via signer_connect.',
      inputSchema: {
        kind: z.number().describe('Event kind (e.g., 0 for metadata, 1 for note)'),
        content: z.string().describe('Event content'),
        tags: z
          .array(z.array(z.string()))
          .optional()
          .describe('Event tags as array of arrays'),
      },
      annotations: PUBLISHER,
    },
    async (params, extra) => {
      try {
        const manager = getSignerManager();
        const userId = getUserId(extra);

        const signer = manager.getSigner(userId);
        if (!signer) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'No signer connected',
                  message: 'Connect a signer first using signer_connect',
                }),
              },
            ],
          };
        }

        const pubkey = await signer.getPublicKey();

        // Build unsigned event
        const unsignedEvent = buildEvent(pubkey, {
          kind: params.kind,
          content: params.content,
          tags: params.tags,
        });

        // Sign the event
        const signedEvent = await signer.signEvent(unsignedEvent);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  event: signedEvent,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Failed to sign event',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register publish_event tool
 *
 * Publishes a pre-signed event to relays.
 */
function registerPublishEventTool(server: McpServer): void {
  server.registerTool(
    'publish_event',
    {
      title: 'Publish Event',
      description:
        'Publish a signed Nostr event to relays. ' +
        'The event must already be signed (have id and sig).',
      inputSchema: {
        event: z.object({
          id: z.string().describe('Event ID'),
          pubkey: z.string().describe('Author public key'),
          created_at: z.number().describe('Unix timestamp'),
          kind: z.number().describe('Event kind'),
          tags: z.array(z.array(z.string())).describe('Event tags'),
          content: z.string().describe('Event content'),
          sig: z.string().describe('Event signature'),
        }).describe('Signed Nostr event'),
        relays: z
          .array(z.string())
          .optional()
          .describe('Relays to publish to (defaults to AMB relays)'),
        useOutbox: z
          .boolean()
          .optional()
          .describe('Use NIP-65 outbox model for relay selection (default: true)'),
      },
      annotations: PUBLISHER,
    },
    async (params, extra) => {
      try {
        const event = params.event as NostrEvent;

        // Verify the event
        if (!verifyEvent(event)) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Invalid event',
                  message: 'Event signature verification failed',
                }),
              },
            ],
          };
        }

        const publishService = getPublishService();

        // Get signer for NIP-42 auth (optional)
        const manager = getSignerManager();
        const userId = getUserId(extra);
        const signer = manager.getSigner(userId);

        // Publish with outbox model
        const result = await publishService.publishWithOutbox(
          event,
          {
            defaultRelays: params.relays || DEFAULT_RELAYS,
            useOutbox: params.useOutbox ?? true,
          },
          signer || undefined
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: result.successes.length > 0,
                  eventId: event.id,
                  publishedTo: result.successes,
                  failures: result.failures.length > 0 ? result.failures : undefined,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Failed to publish event',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register create_and_publish_metadata tool
 *
 * Builds, signs, and publishes a kind 0 (metadata/profile) event.
 */
function registerCreateAndPublishMetadataTool(server: McpServer): void {
  server.registerTool(
    'create_and_publish_metadata',
    {
      title: 'Create and Publish Profile Metadata',
      description:
        'Build, sign, and publish a kind 0 profile metadata event. ' +
        'The signer must be connected first.',
      inputSchema: {
        name: z.string().optional().describe('Display name'),
        about: z.string().optional().describe('Bio/description'),
        picture: z.string().optional().describe('Avatar URL'),
        banner: z.string().optional().describe('Banner image URL'),
        nip05: z.string().optional().describe('NIP-05 identifier (e.g., user@domain.com)'),
        lud16: z.string().optional().describe('Lightning address'),
        website: z.string().optional().describe('Website URL'),
        relays: z
          .array(z.string())
          .optional()
          .describe('Relays to publish to (defaults to AMB relays)'),
        useOutbox: z
          .boolean()
          .optional()
          .describe('Use NIP-65 outbox model for relay selection (default: true)'),
      },
      annotations: PUBLISHER,
    },
    async (params, extra) => {
      try {
        const manager = getSignerManager();
        const userId = getUserId(extra);

        const signer = manager.getSigner(userId);
        if (!signer) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'No signer connected',
                  message: 'Connect a signer first using signer_connect',
                }),
              },
            ],
          };
        }

        const pubkey = await signer.getPublicKey();

        // Build metadata event
        const { relays: _relays, useOutbox: _useOutbox, ...metadata } = params;
        const unsignedEvent = buildMetadataEvent(pubkey, metadata);

        // Sign the event
        const signedEvent = await signer.signEvent(unsignedEvent);

        // Publish with outbox model
        const publishService = getPublishService();
        const result = await publishService.publishWithOutbox(
          signedEvent as NostrEvent,
          {
            defaultRelays: params.relays || DEFAULT_RELAYS,
            useOutbox: params.useOutbox ?? true,
          },
          signer
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: result.successes.length > 0,
                  eventId: signedEvent.id,
                  pubkey,
                  publishedTo: result.successes,
                  failures: result.failures.length > 0 ? result.failures : undefined,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Failed to create and publish metadata',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register create_and_publish_resource tool
 *
 * Builds, signs, and publishes a kind 30142 AMB educational resource event.
 */
function registerCreateAndPublishResourceTool(server: McpServer): void {
  server.registerTool(
    'create_and_publish_resource',
    {
      title: 'Create and Publish Educational Resource',
      description:
        'Build, sign, and publish a kind 30142 AMB educational resource event. ' +
        'The signer must be connected first.',
      inputSchema: {
        identifier: z.string().describe('Unique identifier (d-tag) for the resource'),
        name: z.string().describe('Resource name/title'),
        description: z.string().optional().describe('Resource description'),
        url: z.string().optional().describe('Resource URL'),
        image: z.string().optional().describe('Image/thumbnail URL'),
        type: z
          .array(z.string())
          .optional()
          .describe('Resource types (e.g., ["LearningResource", "VideoObject"])'),
        inLanguage: z
          .array(z.string())
          .optional()
          .describe('Language codes (e.g., ["de", "en"])'),
        about: z
          .array(conceptSchema)
          .optional()
          .describe('Subject/topic concepts'),
        learningResourceType: z
          .array(conceptSchema)
          .optional()
          .describe('Learning resource type concepts (from HCRT vocabulary)'),
        educationalLevel: z
          .array(conceptSchema)
          .optional()
          .describe('Educational level concepts'),
        creator: z
          .array(entitySchema)
          .optional()
          .describe('Content creators'),
        publisher: z
          .array(entitySchema)
          .optional()
          .describe('Publishers'),
        license: z
          .object({
            id: z.string().describe('License URL'),
            name: z.string().optional().describe('License name'),
          })
          .optional()
          .describe('License information'),
        isAccessibleForFree: z
          .boolean()
          .optional()
          .describe('Is the resource free to access'),
        datePublished: z.string().optional().describe('Publication date (ISO 8601)'),
        relays: z
          .array(z.string())
          .optional()
          .describe('Relays to publish to (defaults to AMB relays)'),
        useOutbox: z
          .boolean()
          .optional()
          .describe('Use NIP-65 outbox model for relay selection (default: true)'),
      },
      annotations: PUBLISHER,
    },
    async (params, extra) => {
      try {
        const manager = getSignerManager();
        const userId = getUserId(extra);

        const signer = manager.getSigner(userId);
        if (!signer) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'No signer connected',
                  message: 'Connect a signer first using signer_connect',
                }),
              },
            ],
          };
        }

        const pubkey = await signer.getPublicKey();

        // Build resource input
        const { relays: _relays, useOutbox: _useOutbox, ...resourceParams } = params;
        const resourceInput: AMBResourceInput = {
          identifier: resourceParams.identifier,
          name: resourceParams.name,
          description: resourceParams.description,
          url: resourceParams.url,
          image: resourceParams.image,
          type: resourceParams.type,
          inLanguage: resourceParams.inLanguage,
          about: resourceParams.about as AMBConcept[] | undefined,
          learningResourceType: resourceParams.learningResourceType as AMBConcept[] | undefined,
          educationalLevel: resourceParams.educationalLevel as AMBConcept[] | undefined,
          creator: resourceParams.creator as AMBEntity[] | undefined,
          publisher: resourceParams.publisher as AMBEntity[] | undefined,
          license: resourceParams.license,
          isAccessibleForFree: resourceParams.isAccessibleForFree,
          datePublished: resourceParams.datePublished,
        };

        // Build AMB resource event
        const unsignedEvent = buildAMBResourceEvent(pubkey, resourceInput);

        // Sign the event
        const signedEvent = await signer.signEvent(unsignedEvent);

        // Publish with outbox model
        const publishService = getPublishService();
        const result = await publishService.publishWithOutbox(
          signedEvent as NostrEvent,
          {
            defaultRelays: params.relays || DEFAULT_RELAYS,
            useOutbox: params.useOutbox ?? true,
          },
          signer
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: result.successes.length > 0,
                  eventId: signedEvent.id,
                  identifier: resourceInput.identifier,
                  pubkey,
                  publishedTo: result.successes,
                  failures: result.failures.length > 0 ? result.failures : undefined,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Failed to create and publish resource',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register all publish tools
 */
export function registerPublishTools(server: McpServer): void {
  registerSignEventTool(server);
  registerPublishEventTool(server);
  registerCreateAndPublishMetadataTool(server);
  registerCreateAndPublishResourceTool(server);
}
