/**
 * Signer Manager
 *
 * Manages NIP-46 signer sessions for multiple users.
 * Uses applesauce-signers for the core NIP-46 implementation.
 */

import { SimpleSigner, NostrConnectSigner, PrivateKeySigner } from 'applesauce-signers';
import { RelayPool } from 'applesauce-relay';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import type { Filter } from 'nostr-tools';
import QRCode from 'qrcode-terminal';

// Type for signer that can sign events
export interface Signer {
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedEvent): Promise<SignedEvent>;
}

export interface UnsignedEvent {
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface SignedEvent extends UnsignedEvent {
  id: string;
  sig: string;
}

export interface SignerSession {
  signer: Signer;
  userPubkey: string;
  connectedAt: number;
}

export interface PendingConnection {
  clientSecretKey: Uint8Array;
  clientPubkey: string;
  nostrconnectUrl: string;
  relays: string[];
  secret: string;
  createdAt: number;
  // Active signer listening for connection
  nostrConnectSigner?: NostrConnectSigner;
  // Promise that resolves when bunker connects
  connectionPromise?: Promise<string>;
  // User ID associated with this connection
  userId?: string;
  // Whether the connection has been established
  connected?: boolean;
  // The user's pubkey once connected
  userPubkey?: string;
}

export interface InitConnectionResult {
  nostrconnectUrl: string;
  qrCode: string;
  sessionId: string;
}

export interface ConnectionStatus {
  connected: boolean;
  userPubkey?: string;
  connectedAt?: number;
  // Indicates a pending connection is waiting for bunker
  pendingConnection?: boolean;
  pendingSessionId?: string;
}

/**
 * Parse a bunker:// URL into its components
 */
function parseBunkerUrl(url: string): {
  remotePubkey: string;
  relays: string[];
  secret?: string;
} {
  if (!url.startsWith('bunker://')) {
    throw new Error('Invalid bunker URL: must start with bunker://');
  }

  const parsed = new URL(url);
  const remotePubkey = parsed.pathname.replace('//', '');

  if (!remotePubkey || remotePubkey.length !== 64) {
    throw new Error('Invalid bunker URL: missing or invalid pubkey');
  }

  const relays = parsed.searchParams.getAll('relay');
  if (relays.length === 0) {
    throw new Error('Invalid bunker URL: at least one relay is required');
  }

  const secret = parsed.searchParams.get('secret') || undefined;

  return { remotePubkey, relays, secret };
}

/**
 * Generate a nostrconnect:// URL for client-initiated connection
 */
function generateNostrConnectUrl(opts: {
  clientPubkey: string;
  relays: string[];
  secret: string;
  name?: string;
  permissions?: string[];
}): string {
  const params = new URLSearchParams();

  // Add relays
  for (const relay of opts.relays) {
    params.append('relay', relay);
  }

  // Required: secret for verification
  params.set('secret', opts.secret);

  // Optional: client name
  if (opts.name) {
    params.set('name', opts.name);
  }

  // Optional: requested permissions
  if (opts.permissions && opts.permissions.length > 0) {
    params.set('perms', opts.permissions.join(','));
  }

  return `nostrconnect://${opts.clientPubkey}?${params.toString()}`;
}

/**
 * Generate ASCII QR code for terminal display
 */
function generateQRCode(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use qrcode-terminal to generate ASCII QR
    let output = '';
    const originalWrite = process.stdout.write.bind(process.stdout);

    // Temporarily capture stdout
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      if (typeof chunk === 'string') {
        output += chunk;
      }
      return true;
    };

    QRCode.generate(text, { small: true }, (qrcode?: string) => {
      // Restore stdout
      process.stdout.write = originalWrite;

      if (qrcode) {
        resolve(qrcode);
      } else if (output) {
        resolve(output);
      } else {
        reject(new Error('Failed to generate QR code'));
      }
    });
  });
}

/**
 * Signer Manager for NIP-46 remote signing
 *
 * Manages per-user signer sessions with user isolation.
 */
export class SignerManager {
  private sessions: Map<string, SignerSession> = new Map();
  private pendingConnections: Map<string, PendingConnection> = new Map();
  private pool: RelayPool;
  private defaultRelays: string[];

  constructor(defaultRelays: string[]) {
    this.pool = new RelayPool();
    this.defaultRelays = defaultRelays;
  }

  /**
   * Initialize a client-initiated connection (generates QR code)
   *
   * This creates a nostrconnect:// URL that can be scanned by a bunker app.
   * Connection is handled automatically in the background - no need to call awaitConnection.
   * Use getStatus() to check if connected.
   */
  async initConnection(
    userId: string,
    opts?: {
      relays?: string[];
      name?: string;
      permissions?: string[];
    }
  ): Promise<InitConnectionResult> {
    // Generate client keypair for this connection
    const clientSecretKey = generateSecretKey();
    const clientPubkey = getPublicKey(clientSecretKey);

    // Generate random secret for verification
    const secret = Math.random().toString(36).substring(2, 10);

    const relays = opts?.relays || this.defaultRelays;

    // Generate nostrconnect:// URL
    const nostrconnectUrl = generateNostrConnectUrl({
      clientPubkey,
      relays,
      secret,
      name: opts?.name || 'nope-mcp',
      permissions: opts?.permissions || ['sign_event'],
    });

    // Generate QR code
    const qrCode = await generateQRCode(nostrconnectUrl);

    // Create session ID (client pubkey is unique per connection attempt)
    const sessionId = clientPubkey;

    // Create PrivateKeySigner for encryption
    const clientSigner = new PrivateKeySigner(clientSecretKey);

    // Create NostrConnectSigner to handle NIP-46 protocol
    const nostrConnectSigner = new NostrConnectSigner({
      relays,
      signer: clientSigner,
      secret,
      // Wire up relay pool for subscriptions
      subscriptionMethod: (subRelays: string[], filters: Filter[]) => {
        return this.pool.req(subRelays, filters[0]);
      },
      // Wire up relay pool for publishing
      publishMethod: async (pubRelays: string[], event: SignedEvent) => {
        await this.pool.publish(pubRelays, event);
      },
    });

    // Store pending connection with userId
    const pending: PendingConnection = {
      clientSecretKey,
      clientPubkey,
      nostrconnectUrl,
      relays,
      secret,
      createdAt: Date.now(),
      nostrConnectSigner,
      userId,
      connected: false,
    };

    this.pendingConnections.set(sessionId, pending);

    // Start listening in background
    this.startBackgroundConnection(sessionId, pending);

    return {
      nostrconnectUrl,
      qrCode,
      sessionId,
    };
  }

  /**
   * Start listening for bunker connection in background
   */
  private async startBackgroundConnection(
    sessionId: string,
    pending: PendingConnection
  ): Promise<void> {
    const { nostrConnectSigner, userId } = pending;
    if (!nostrConnectSigner || !userId) return;

    try {
      // Open connection (starts listening for kind 24133 events)
      await nostrConnectSigner.open();

      // Wait for bunker to connect (5 minute timeout)
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), 5 * 60 * 1000);

      try {
        await nostrConnectSigner.waitForSigner(abortController.signal);
      } finally {
        clearTimeout(timeout);
      }

      // Connection successful! Get user's pubkey
      const userPubkey = await nostrConnectSigner.getPublicKey();

      // Update pending connection status
      pending.connected = true;
      pending.userPubkey = userPubkey;

      // Move to active sessions
      this.sessions.set(userId, {
        signer: nostrConnectSigner,
        userPubkey,
        connectedAt: Date.now(),
      });

      // Clean up pending
      this.pendingConnections.delete(sessionId);

      console.log(`[SignerManager] Bunker connected for user ${userId}: ${userPubkey}`);
    } catch (error) {
      // Connection failed or timed out
      console.error(`[SignerManager] Background connection failed:`, error);
      // Clean up pending connection after timeout
      this.pendingConnections.delete(sessionId);
    }
  }

  /**
   * Wait for a bunker to connect after scanning the QR code
   *
   * Uses NostrConnectSigner to handle the NIP-46 protocol:
   * 1. Subscribe to kind 24133 events on the relays
   * 2. Wait for bunker's connect response
   * 3. Decrypt and verify the response (secret must match)
   * 4. Store the signer for future signing requests
   */
  async awaitConnection(
    userId: string,
    sessionId: string,
    timeoutMs: number = 120000
  ): Promise<string> {
    const pending = this.pendingConnections.get(sessionId);
    if (!pending) {
      throw new Error('No pending connection found for this session ID');
    }

    // Create PrivateKeySigner from client secret key for encryption
    const clientSigner = new PrivateKeySigner(pending.clientSecretKey);

    // Create NostrConnectSigner for client-initiated flow
    const nostrConnectSigner = new NostrConnectSigner({
      relays: pending.relays,
      signer: clientSigner,
      secret: pending.secret,
      // Wire up relay pool for subscriptions: (relays, filters) => Observable
      subscriptionMethod: (relays: string[], filters: Filter[]) => {
        return this.pool.req(relays, filters[0]);
      },
      // Wire up relay pool for publishing: (relays, event) => Promise
      publishMethod: async (relays: string[], event: SignedEvent) => {
        await this.pool.publish(relays, event);
      },
    });

    // Open connection (starts listening for events)
    await nostrConnectSigner.open();

    // Wait for bunker to connect with timeout
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      await nostrConnectSigner.waitForSigner(abortController.signal);
    } catch (error) {
      // Clean up on error
      this.pendingConnections.delete(sessionId);
      if (abortController.signal.aborted) {
        throw new Error('Connection timed out waiting for bunker');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    // Get user's pubkey from the signer
    const userPubkey = await nostrConnectSigner.getPublicKey();

    // Store session with the NostrConnectSigner
    this.sessions.set(userId, {
      signer: nostrConnectSigner,
      userPubkey,
      connectedAt: Date.now(),
    });

    // Clean up pending connection
    this.pendingConnections.delete(sessionId);

    return userPubkey;
  }

  /**
   * Connect directly using a bunker:// URL
   *
   * This is the bunker-initiated flow where the bunker provides its URL.
   */
  async connect(
    userId: string,
    bunkerUrl: string
  ): Promise<string> {
    // Parse bunker URL
    const { remotePubkey, relays } = parseBunkerUrl(bunkerUrl);

    // Generate local keypair for encryption
    const localSecretKey = generateSecretKey();

    // For now, use SimpleSigner as a placeholder
    // Full NIP-46 requires implementing the connect handshake
    // which involves sending connect request and waiting for ack
    //
    // TODO: Use Nip46Signer when we implement the full flow
    // For development/testing, we can use a SimpleSigner with a provided key

    throw new Error(
      'Bunker connection not yet fully implemented. ' +
        'For development, use signer_connect with nsec parameter and allowInsecure=true.'
    );
  }

  /**
   * Connect with a private key (for development/testing only)
   *
   * WARNING: Only use this for development. Never expose private keys in production.
   */
  async connectWithKey(userId: string, nsecOrHex: string): Promise<string> {
    let secretKey: Uint8Array;

    // Handle nsec (bech32) or hex format
    if (nsecOrHex.startsWith('nsec')) {
      const decoded = nip19.decode(nsecOrHex);
      if (decoded.type !== 'nsec') {
        throw new Error('Invalid nsec format');
      }
      secretKey = decoded.data;
    } else {
      // Assume hex format
      if (nsecOrHex.length !== 64) {
        throw new Error('Invalid hex key: must be 64 characters');
      }
      secretKey = hexToBytes(nsecOrHex);
    }

    const signer = new SimpleSigner(secretKey);
    const userPubkey = await signer.getPublicKey();

    this.sessions.set(userId, {
      signer,
      userPubkey,
      connectedAt: Date.now(),
    });

    return userPubkey;
  }

  /**
   * Disconnect a user's signer session
   */
  async disconnect(userId: string): Promise<boolean> {
    const session = this.sessions.get(userId);
    if (!session) {
      return false;
    }

    this.sessions.delete(userId);
    return true;
  }

  /**
   * Get a user's signer (returns null if not connected)
   */
  getSigner(userId: string): Signer | null {
    const session = this.sessions.get(userId);
    return session?.signer || null;
  }

  /**
   * Get connection status for a user
   */
  getStatus(userId: string): ConnectionStatus {
    // Check active sessions first
    const session = this.sessions.get(userId);
    if (session) {
      return {
        connected: true,
        userPubkey: session.userPubkey,
        connectedAt: session.connectedAt,
      };
    }

    // Check for pending connections for this user
    for (const [sessionId, pending] of this.pendingConnections) {
      if (pending.userId === userId) {
        // Check if it has connected in the background
        if (pending.connected && pending.userPubkey) {
          return {
            connected: true,
            userPubkey: pending.userPubkey,
          };
        }
        // Still waiting for bunker
        return {
          connected: false,
          pendingConnection: true,
          pendingSessionId: sessionId,
        };
      }
    }

    return { connected: false };
  }

  /**
   * Clean up pending connections older than the specified age
   */
  cleanupPendingConnections(maxAgeMs: number = 300000): void {
    const now = Date.now();
    for (const [sessionId, pending] of this.pendingConnections) {
      if (now - pending.createdAt > maxAgeMs) {
        this.pendingConnections.delete(sessionId);
      }
    }
  }

  /**
   * Get the relay pool (for publishing)
   */
  getRelayPool(): RelayPool {
    return this.pool;
  }

  /**
   * Close all connections and clean up
   */
  close(): void {
    this.sessions.clear();
    this.pendingConnections.clear();
  }
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
