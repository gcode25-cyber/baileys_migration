import { makeWASocket, DisconnectReason, useMultiFileAuthState, proto, WAMessage, WASocket, isJidBroadcast, isJidGroup, isJidUser, BaileysEventMap, Chat } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qr-image';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { storage } from '../storage';
import type { WebSocket } from 'ws';

// Create a logger
const logger = pino({ level: 'warn' });

export class WhatsAppService {
  private socket: WASocket | null = null;
  private qrCode: string | null = null;
  private sessionInfo: any = null;
  private isReady: boolean = false;
  private isInitializing: boolean = false;
  private messageCache: Map<string, any[]> = new Map();
  private connectionCheckInterval: NodeJS.Timeout | null = null;
  private currentState: string = 'DISCONNECTED';
  private isPhoneConnected: boolean = false;
  private lastStateCheck: Date = new Date();
  private authState: any = null;
  private saveCreds: any = null;

  constructor() {
    this.initializeClient();
    this.startConnectionMonitoring();
  }

  // Helper method to broadcast WebSocket events
  private broadcastToClients(eventType: string, data: any) {
    try {
      const wss = (global as any).wss;
      if (wss && wss.clients) {
        const message = JSON.stringify({ type: eventType, data });
        wss.clients.forEach((client: any) => {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(message);
          }
        });
        console.log(`📡 Broadcasted ${eventType} to ${wss.clients.size} clients`);
      }
    } catch (error) {
      console.error('Failed to broadcast WebSocket message:', error);
    }
  }

  private async initializeClient() {
    if (this.isInitializing) {
      console.log('⚠️ Client already initializing, waiting for completion...');
      let attempts = 0;
      while (this.isInitializing && attempts < 10) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
      }
      
      if (this.isInitializing) {
        console.log('🔄 Force resetting initialization flag after timeout');
        this.isInitializing = false;
      }
    }
    
    // Clean up existing socket
    if (this.socket) {
      try {
        this.socket.end(undefined);
        console.log('🧹 Destroyed existing socket before reinitializing');
      } catch (e: any) {
        console.log('Previous socket cleanup:', e.message);
      }
      this.socket = null;
    }

    try {
      this.isInitializing = true;
      console.log('🚀 Initializing WhatsApp client with Baileys...');

      // Setup authentication state
      const authDir = path.resolve('./baileys_auth');
      if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      this.authState = state;
      this.saveCreds = saveCreds;

      // Check if there's an existing session
      const hasExistingSession = state.creds.registered;
      
      // Also check for stored session info in database
      let storedSessionInfo = null;
      try {
        const activeSessions = await storage.getActiveSessions();
        if (activeSessions.length > 0) {
          storedSessionInfo = activeSessions[0];
          console.log('📦 Found stored session info:', storedSessionInfo.userId);
        }
      } catch (error: any) {
        console.log('Session info retrieval failed:', error.message);
      }
      
      if (hasExistingSession) {
        console.log('🔍 Found existing session files, attempting automatic restoration...');
        
        if (storedSessionInfo) {
          console.log('📦 Restoring from stored session info for UI');
          this.sessionInfo = {
            number: storedSessionInfo.userId,
            name: storedSessionInfo.userName,
            loginTime: storedSessionInfo.loginTime
          };
        } else {
          console.log('📋 Session files exist, will restore on WhatsApp ready event');
        }
        
        this.isReady = false;
      } else {
        console.log('📱 No existing session found, will require QR authentication');
      }

      // Reset state but preserve session info if we're restoring
      this.isReady = false;
      this.qrCode = null;

      // Create WhatsApp socket
      this.socket = makeWASocket({
        auth: state,
        logger,
        printQRInTerminal: false, // We'll handle QR code generation ourselves
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        emitOwnEvents: true,
        fireInitQueries: true,
        markOnlineOnConnect: true,
      });

      console.log('✅ Starting client initialization...');

      // Set up event handlers
      this.setupEventHandlers();

      this.isInitializing = false;
      console.log('🎯 Client initialization completed successfully');

    } catch (error: any) {
      this.isInitializing = false;
      console.error('❌ Failed to initialize WhatsApp client:', error.message);
      this.currentState = 'DISCONNECTED';
      this.isReady = false;
      this.broadcastToClients('connection_status', { 
        status: 'DISCONNECTED',
        isReady: false,
        phoneConnected: false
      });
    }
  }

  private setupEventHandlers() {
    if (!this.socket) return;

    // Connection updates
    this.socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      console.log('🔌 Connection update:', connection);

      if (qr) {
        console.log('📱 New QR Code received from WhatsApp');
        this.handleQRCode(qr);
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('🔌 Connection closed due to:', lastDisconnect?.error, ', reconnecting:', shouldReconnect);
        
        this.currentState = 'DISCONNECTED';
        this.isReady = false;
        this.isPhoneConnected = false;
        
        this.broadcastToClients('connection_status', { 
          status: 'DISCONNECTED',
          isReady: false,
          phoneConnected: false
        });

        if (shouldReconnect) {
          setTimeout(() => this.initializeClient(), 3000);
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp connection opened successfully');
        this.currentState = 'CONNECTED';
        this.isReady = true;
        this.isPhoneConnected = true;
        
        this.handleConnectionSuccess();
      }
    });

    // Credentials update
    this.socket.ev.on('creds.update', this.saveCreds);

    // Messages
    this.socket.ev.on('messages.upsert', (m) => {
      this.handleMessages(m);
    });

    // Presence updates
    this.socket.ev.on('presence.update', (presence) => {
      console.log('👤 Presence update:', presence);
    });

    // Chats - using correct event name
    this.socket.ev.on('chats.upsert', (chats) => {
      console.log('💬 Chats upsert:', chats.length);
    });

    // Groups
    this.socket.ev.on('groups.upsert', (groups) => {
      console.log('👥 Groups upsert:', groups.length);
    });
  }

  private async handleQRCode(qr: string) {
    try {
      this.qrCode = qr;
      
      // Generate QR code as PNG buffer
      const qrPng = qrcode.image(qr, { type: 'png' });
      const chunks: Buffer[] = [];
      
      qrPng.on('data', (chunk: Buffer) => chunks.push(chunk));
      qrPng.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const base64 = buffer.toString('base64');
        const dataUrl = `data:image/png;base64,${base64}`;
        
        console.log('✅ QR Code generated successfully with Baileys');
        
        // Broadcast QR code to connected clients
        this.broadcastToClients('qr', dataUrl);
      });

      // Also display QR in terminal for debugging
      qrcodeTerminal.generate(qr, { small: true });

      console.log('⚠️ Note: QR code means session was not restored or has expired');
      console.log('🔍 QR String type:', typeof qr);
      console.log('🔍 QR String length:', qr.length);
      console.log('🔍 QR String preview:', qr.substring(0, 100) + '...');

    } catch (error: any) {
      console.error('❌ Failed to generate QR code:', error.message);
    }
  }

  private async handleConnectionSuccess() {
    try {
      if (!this.socket) return;

      // Get user info
      const userInfo = this.socket.user;
      if (userInfo) {
        const phoneNumber = userInfo.id.split('@')[0];
        const userName = userInfo.name || userInfo.verifiedName || phoneNumber;
        
        this.sessionInfo = {
          number: phoneNumber,
          name: userName,
          loginTime: new Date().toISOString()
        };

        console.log('📞 WhatsApp account connected:', {
          number: phoneNumber,
          name: userName
        });

        // Store session info in database
        try {
          await storage.storeSessionInfo(phoneNumber, userName, new Date());
          console.log('💾 Session info stored successfully');
        } catch (error: any) {
          console.error('Failed to store session info:', error.message);
        }

        // Broadcast success
        this.broadcastToClients('connection_status', { 
          status: 'CONNECTED',
          isReady: true,
          phoneConnected: true,
          sessionInfo: this.sessionInfo
        });

        // Clear QR code
        this.qrCode = null;
        this.broadcastToClients('qr_cleared', {});
        
        // Load initial data to populate chats and groups
        await this.loadInitialData();
      }
    } catch (error: any) {
      console.error('❌ Failed to handle connection success:', error.message);
    }
  }

  private async loadInitialData() {
    try {
      console.log('🔄 Loading initial WhatsApp data...');
      
      // Since Baileys doesn't have a direct way to get all chats,
      // we'll wait for incoming messages to populate our cache
      console.log('📱 Ready to receive messages and populate chat data');
      
    } catch (error: any) {
      console.error('❌ Error loading initial data:', error.message);
    }
  }

  private async handleMessages(messageUpdate: { messages: WAMessage[], type: 'notify' | 'append' }) {
    try {
      for (const message of messageUpdate.messages) {
        if (!message.key.fromMe && messageUpdate.type === 'notify') {
          console.log('📨 New message received:', {
            from: message.key.remoteJid,
            messageType: Object.keys(message.message || {})[0],
            timestamp: message.messageTimestamp
          });

          // Store message for real-time chat updates
          const chatId = message.key.remoteJid!;
          if (!this.messageCache.has(chatId)) {
            this.messageCache.set(chatId, []);
          }
          
          const messages = this.messageCache.get(chatId)!;
          messages.push(message);
          
          // Keep only last 50 messages per chat in cache
          if (messages.length > 50) {
            messages.splice(0, messages.length - 50);
          }

          // Broadcast new message to connected clients
          this.broadcastToClients('new_message', {
            chatId,
            message: this.formatMessage(message)
          });
        }
      }
    } catch (error: any) {
      console.error('❌ Failed to handle messages:', error.message);
    }
  }

  private formatMessage(message: WAMessage): any {
    const messageContent = message.message;
    if (!messageContent) return null;

    let body = '';
    let messageType = 'text';
    let mediaUrl = null;

    if (messageContent.conversation) {
      body = messageContent.conversation;
    } else if (messageContent.extendedTextMessage) {
      body = messageContent.extendedTextMessage.text || '';
    } else if (messageContent.imageMessage) {
      body = messageContent.imageMessage.caption || '';
      messageType = 'image';
    } else if (messageContent.videoMessage) {
      body = messageContent.videoMessage.caption || '';
      messageType = 'video';
    } else if (messageContent.documentMessage) {
      body = messageContent.documentMessage.fileName || 'Document';
      messageType = 'document';
    } else if (messageContent.audioMessage) {
      body = 'Audio message';
      messageType = 'audio';
    }

    return {
      id: message.key.id,
      body,
      messageType,
      mediaUrl,
      timestamp: message.messageTimestamp ? new Date(Number(message.messageTimestamp) * 1000) : new Date(),
      fromMe: message.key.fromMe || false,
      author: message.key.participant || message.key.remoteJid
    };
  }

  // Connection monitoring
  private startConnectionMonitoring() {
    if (this.connectionCheckInterval) {
      clearInterval(this.connectionCheckInterval);
    }

    this.connectionCheckInterval = setInterval(() => {
      this.checkConnectionStatus();
    }, 30000); // Check every 30 seconds
  }

  private async checkConnectionStatus() {
    try {
      if (!this.socket || !this.isReady) {
        return;
      }

      // Simple ping to check if connection is alive
      const now = new Date();
      if (now.getTime() - this.lastStateCheck.getTime() > 60000) { // Check every minute
        this.lastStateCheck = now;
        
        // Try to get user info to verify connection
        if (this.socket.user) {
          console.log('💓 Connection heartbeat: OK');
        }
      }
    } catch (error: any) {
      console.error('Connection check failed:', error.message);
      this.currentState = 'DISCONNECTED';
      this.isPhoneConnected = false;
      this.broadcastToClients('connection_status', { 
        status: 'DISCONNECTED',
        isReady: false,
        phoneConnected: false
      });
    }
  }

  // Public methods for API endpoints
  public getQRCode(): string | null {
    return this.qrCode;
  }

  public getSessionInfo(): any {
    return this.sessionInfo;
  }

  public isClientReady(): boolean {
    return this.isReady && this.socket !== null;
  }

  public getConnectionStatus(): any {
    return {
      status: this.currentState,
      isReady: this.isReady,
      phoneConnected: this.isPhoneConnected,
      sessionInfo: this.sessionInfo
    };
  }

  public async logout(): Promise<void> {
    try {
      console.log('🚪 Starting WhatsApp logout process...');
      
      if (this.socket) {
        await this.socket.logout();
        this.socket.end(undefined);
        this.socket = null;
      }

      // Clear auth files
      const authDir = path.resolve('./baileys_auth');
      if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
        console.log('🗑️ Cleared authentication files');
      }

      // Clear session info from database
      try {
        await storage.clearSessionInfo();
        console.log('💾 Cleared session info from database');
      } catch (error: any) {
        console.error('Failed to clear session info:', error.message);
      }

      // Reset state
      this.sessionInfo = null;
      this.isReady = false;
      this.isPhoneConnected = false;
      this.currentState = 'DISCONNECTED';
      this.qrCode = null;
      this.messageCache.clear();

      console.log('✅ Logout completed successfully');

      // Broadcast logout status
      this.broadcastToClients('connection_status', { 
        status: 'DISCONNECTED',
        isReady: false,
        phoneConnected: false,
        sessionInfo: null
      });

      // Reinitialize for new QR code
      setTimeout(() => {
        console.log('🔄 Reinitializing client for new session...');
        this.initializeClient();
      }, 2000);

    } catch (error: any) {
      console.error('❌ Logout failed:', error.message);
      throw error;
    }
  }

  public async sendMessage(to: string, message: string): Promise<any> {
    try {
      if (!this.socket || !this.isReady) {
        throw new Error('WhatsApp client is not ready');
      }

      // Format phone number (ensure it has country code and @s.whatsapp.net)
      let jid = to;
      if (!jid.includes('@')) {
        jid = `${jid}@s.whatsapp.net`;
      }

      console.log(`📤 Sending message to ${jid}: ${message.substring(0, 50)}...`);

      const result = await this.socket.sendMessage(jid, { text: message });
      
      console.log('✅ Message sent successfully');
      return {
        success: true,
        messageId: result?.key?.id,
        timestamp: new Date()
      };

    } catch (error: any) {
      console.error('❌ Failed to send message:', error.message);
      throw error;
    }
  }

  public async sendMediaMessage(to: string, mediaBuffer: Buffer, caption?: string, filename?: string): Promise<any> {
    try {
      if (!this.socket || !this.isReady) {
        throw new Error('WhatsApp client is not ready');
      }

      let jid = to;
      if (!jid.includes('@')) {
        jid = `${jid}@s.whatsapp.net`;
      }

      console.log(`📤 Sending media message to ${jid}${caption ? ` with caption: ${caption.substring(0, 50)}...` : ''}`);

      const result = await this.socket.sendMessage(jid, { 
        document: mediaBuffer,
        mimetype: 'application/octet-stream',
        fileName: filename || 'file',
        caption: caption 
      });

      console.log('✅ Media message sent successfully');
      return {
        success: true,
        messageId: result?.key?.id,
        timestamp: new Date()
      };

    } catch (error: any) {
      console.error('❌ Failed to send media message:', error.message);
      throw error;
    }
  }

  public async getChats(): Promise<any[]> {
    try {
      if (!this.socket || !this.isReady) {
        return [];
      }

      // Get chats from local cache since Baileys doesn't have getChatList
      // We'll build this from stored messages
      const chats: any[] = [];
      
      this.messageCache.forEach((messages, chatId) => {
        if (messages.length > 0) {
          const lastMessage = messages[messages.length - 1];
          chats.push({
            id: chatId,
            name: chatId.split('@')[0],
            isGroup: isJidGroup(chatId),
            unreadCount: 0,
            lastMessageTime: Number(lastMessage.messageTimestamp) * 1000 || Date.now(),
            lastMessage: this.formatMessage(lastMessage)
          });
        }
      });

      return chats;

    } catch (error: any) {
      console.error('❌ Failed to get chats:', error.message);
      return [];
    }
  }

  public async getGroups(): Promise<any[]> {
    try {
      if (!this.socket || !this.isReady) {
        return [];
      }

      // Get groups from message cache (groups have @g.us suffix)
      const groups: any[] = [];
      
      this.messageCache.forEach((messages, chatId) => {
        if (isJidGroup(chatId) && messages.length > 0) {
          groups.push({
            id: chatId,
            name: chatId.split('@')[0],
            description: '',
            participantsCount: 0,
            isAdmin: false,
            participants: []
          });
        }
      });

      // Try to get group metadata for known groups
      for (const group of groups) {
        try {
          const metadata = await this.socket.groupMetadata(group.id);
          group.name = metadata.subject;
          group.description = metadata.desc || '';
          group.participantsCount = metadata.participants.length;
          group.isAdmin = metadata.participants.some(p => p.id === this.socket!.user?.id && (p.admin === 'admin' || p.admin === 'superadmin'));
          group.participants = metadata.participants.map(p => ({
            id: p.id,
            isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
            phone: p.id.split('@')[0]
          }));
        } catch (error: any) {
          console.error(`Failed to get metadata for group ${group.id}:`, error.message);
        }
      }

      return groups;

    } catch (error: any) {
      console.error('❌ Failed to get groups:', error.message);
      return [];
    }
  }

  public async getChatMessages(chatId: string, limit: number = 50): Promise<any[]> {
    try {
      if (!this.socket || !this.isReady) {
        return [];
      }

      // First check cache
      if (this.messageCache.has(chatId)) {
        const cachedMessages = this.messageCache.get(chatId)!;
        if (cachedMessages.length > 0) {
          return cachedMessages.slice(-limit).map(msg => this.formatMessage(msg)).filter(Boolean);
        }
      }

      // For Baileys, we'll primarily use cached messages
      // As message fetching is more complex and requires specific message keys
      console.log(`📨 Returning cached messages for chat ${chatId}`);
      return [];

    } catch (error: any) {
      console.error('❌ Failed to get chat messages:', error.message);
      return [];
    }
  }

  public async clearChat(chatId: string): Promise<void> {
    try {
      if (!this.socket || !this.isReady) {
        throw new Error('WhatsApp client is not ready');
      }

      // For Baileys, we'll just clear from cache
      // Actual message deletion is more complex and requires specific message handling
      this.messageCache.delete(chatId);
      
      console.log(`✅ Chat ${chatId} cleared from cache`);

    } catch (error: any) {
      console.error('❌ Failed to clear chat:', error.message);
      throw error;
    }
  }

  public async deleteChat(chatId: string): Promise<void> {
    try {
      if (!this.socket || !this.isReady) {
        throw new Error('WhatsApp client is not ready');
      }

      // For Baileys, we'll just clear from cache
      this.messageCache.delete(chatId);
      
      console.log(`✅ Chat ${chatId} deleted from cache`);

    } catch (error: any) {
      console.error('❌ Failed to delete chat:', error.message);
      throw error;
    }
  }

  public async getContacts(): Promise<any[]> {
    try {
      if (!this.socket || !this.isReady) {
        return [];
      }

      // For Baileys, contacts are built from store data
      // We'll return contacts from our message cache for now
      const contacts: any[] = [];
      
      this.messageCache.forEach((messages, chatId) => {
        if (!isJidGroup(chatId) && messages.length > 0) {
          const phoneNumber = chatId.split('@')[0];
          const lastMessage = messages[messages.length - 1];
          
          // Try to get contact name from message pushName or use phone number
          const contactName = lastMessage.pushName || phoneNumber;
          
          contacts.push({
            id: chatId,
            name: contactName,
            number: phoneNumber,
            isUser: true,
            profilePic: null
          });
        }
      });

      return contacts;

    } catch (error: any) {
      console.error('❌ Failed to get contacts:', error.message);
      return [];
    }
  }

  public cleanup(): void {
    console.log('🧹 Cleaning up WhatsApp service...');
    
    if (this.connectionCheckInterval) {
      clearInterval(this.connectionCheckInterval);
      this.connectionCheckInterval = null;
    }

    if (this.socket) {
      try {
        this.socket.end(undefined);
      } catch (error: any) {
        console.error('Error closing socket:', error.message);
      }
      this.socket = null;
    }

    this.messageCache.clear();
    console.log('✅ WhatsApp service cleanup completed');
  }
}

// Create singleton instance
export const whatsappService = new WhatsAppService();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, cleaning up WhatsApp service...');
  whatsappService.cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, cleaning up WhatsApp service...');
  whatsappService.cleanup();
  process.exit(0);
});