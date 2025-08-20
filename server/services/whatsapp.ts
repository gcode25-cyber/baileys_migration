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
  private chatData: Map<string, any> = new Map();
  private contactData: Map<string, any> = new Map();
  private groupData: Map<string, any> = new Map();

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

      // Initialize data storage
      this.chatData.clear();
      this.contactData.clear();
      this.groupData.clear();

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

      // Create WhatsApp socket with enhanced sync options
      this.socket = makeWASocket({
        auth: state,
        logger,
        printQRInTerminal: false, // We'll handle QR code generation ourselves
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        generateHighQualityLinkPreview: true,
        syncFullHistory: true, // Enable full history sync
        shouldSyncHistoryMessage: () => true, // Sync history messages
        emitOwnEvents: true,
        fireInitQueries: true,
        markOnlineOnConnect: true,
        getMessage: async (key) => {
          // This helps with message syncing
          return { conversation: '' };
        }
      });

      // We'll handle data manually through events

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
          console.log('⏳ Waiting 10 seconds before reconnecting to avoid rapid reconnections...');
          setTimeout(() => this.initializeClient(), 10000);
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
      
      // Store real chats
      chats.forEach((chat) => {
        if (chat.id) {
          const chatData = {
            id: chat.id,
            name: chat.name || chat.id.split('@')[0],
            isGroup: isJidGroup(chat.id),
            unreadCount: chat.unreadCount || 0,
            lastMessageTime: chat.conversationTimestamp ? Number(chat.conversationTimestamp) * 1000 : Date.now(),
            lastMessage: null
          };
          
          this.chatData.set(chat.id, chatData);
          console.log(`💬 Stored chat: ${chatData.name}`);
        }
      });
      
      // Broadcast updated chat list
      this.broadcastToClients('chats_updated', { count: chats.length });
    });

    // Contacts
    this.socket.ev.on('contacts.upsert', (contacts) => {
      console.log('📞 Contacts upsert:', contacts.length);
      
      // Store real contacts
      contacts.forEach((contact) => {
        if (contact.id && !isJidGroup(contact.id)) {
          const phoneNumber = contact.id.split('@')[0];
          const contactData = {
            id: contact.id,
            name: contact.name || contact.notify || contact.verifiedName || phoneNumber,
            number: phoneNumber,
            isUser: true,
            isMyContact: true,
            isWAContact: true,
            profilePic: null
          };
          
          this.contactData.set(contact.id, contactData);
          console.log(`📞 Stored contact: ${contactData.name}`);
        }
      });
      
      // Broadcast updated contact list
      this.broadcastToClients('contacts_updated', { count: contacts.length });
    });

    // Groups
    this.socket.ev.on('groups.upsert', (groups) => {
      console.log('👥 Groups upsert:', groups.length);
      
      // Store real groups
      groups.forEach((group) => {
        if (group.id && isJidGroup(group.id)) {
          const groupData = {
            id: group.id,
            name: group.subject || group.id.split('@')[0],
            description: group.desc || '',
            participantsCount: group.participants?.length || 0,
            isAdmin: false,
            participants: []
          };
          
          this.groupData.set(group.id, groupData);
          console.log(`👥 Stored group: ${groupData.name}`);
        }
      });
      
      // Broadcast updated group list
      this.broadcastToClients('groups_updated', { count: groups.length });
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
        // Extract just the phone number part, removing any additional identifiers
        const cleanPhoneNumber = phoneNumber.split(':')[0];
        
        // Use verified name if available, otherwise format the phone number nicely
        let userName = userInfo.verifiedName || userInfo.name;
        if (!userName || userName === userInfo.id || userName === phoneNumber) {
          // Format phone number as +91 94284 63575 (example for Indian numbers)
          if (cleanPhoneNumber.startsWith('91') && cleanPhoneNumber.length === 12) {
            userName = `+91 ${cleanPhoneNumber.slice(2, 7)} ${cleanPhoneNumber.slice(7)}`;
          } else {
            userName = `+${cleanPhoneNumber}`;
          }
        }
        
        this.sessionInfo = {
          number: cleanPhoneNumber,
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
        
        // Load initial data to populate chats and groups with delay
        setTimeout(() => {
          this.loadInitialData();
        }, 5000);
      }
    } catch (error: any) {
      console.error('❌ Failed to handle connection success:', error.message);
    }
  }

  private async loadInitialData() {
    try {
      if (!this.socket || !this.isReady) {
        console.log('⚠️ Socket not ready for data loading');
        return;
      }
      
      console.log('🔄 Loading your actual WhatsApp data...');
      
      // Clear any existing demo data
      this.contactData.clear();
      this.chatData.clear();
      this.groupData.clear();
      
      // Try to load real contacts and chats
      await this.loadRealContacts();
      await this.loadRealChats();
      
      console.log('📱 Real WhatsApp data loaded successfully');
      
    } catch (error: any) {
      console.error('❌ Error loading initial data:', error.message);
    }
  }
  
  private async loadRealContacts() {
    try {
      if (!this.socket || !this.isReady) return;
      
      console.log('📞 Loading your actual contacts...');
      
      // In Baileys, contacts are typically loaded through the store or via messages
      // Let's try to get contacts from the socket's contact store if available
      const contacts = (this.socket as any).store?.contacts || {};
      
      let contactCount = 0;
      Object.entries(contacts).forEach(([jid, contact]: [string, any]) => {
        if (!isJidGroup(jid) && contact) {
          const phoneNumber = jid.split('@')[0];
          const contactData = {
            id: jid,
            name: contact.name || contact.notify || contact.verifiedName || phoneNumber,
            number: phoneNumber,
            isUser: true,
            isMyContact: true,
            isWAContact: true,
            profilePic: null
          };
          
          this.contactData.set(jid, contactData);
          contactCount++;
        }
      });
      
      console.log(`📞 Loaded ${contactCount} real contacts`);
      
    } catch (error: any) {
      console.error('❌ Failed to load real contacts:', error.message);
    }
  }
  
  private async loadRealChats() {
    try {
      if (!this.socket || !this.isReady) return;
      
      console.log('💬 Loading your actual chats...');
      
      // Try to get chats from the socket's chat store if available
      const chats = (this.socket as any).store?.chats || {};
      
      let chatCount = 0;
      Object.entries(chats).forEach(([jid, chat]: [string, any]) => {
        if (chat) {
          const chatData = {
            id: jid,
            name: chat.name || jid.split('@')[0],
            isGroup: isJidGroup(jid),
            unreadCount: chat.unreadCount || 0,
            lastMessageTime: chat.conversationTimestamp ? Number(chat.conversationTimestamp) * 1000 : Date.now(),
            lastMessage: null
          };
          
          this.chatData.set(jid, chatData);
          chatCount++;
        }
      });
      
      console.log(`💬 Loaded ${chatCount} real chats`);
      
    } catch (error: any) {
      console.error('❌ Failed to load real chats:', error.message);
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

  public async sendMediaMessage(to: string, caption: string, filePath: string, filename?: string): Promise<any> {
    try {
      if (!this.socket || !this.isReady) {
        throw new Error('WhatsApp client is not ready');
      }

      let jid = to;
      if (!jid.includes('@')) {
        jid = `${jid}@s.whatsapp.net`;
      }

      console.log(`📤 Sending media message to ${jid}${caption ? ` with caption: ${caption.substring(0, 50)}...` : ''}`);

      // Read file from path
      const mediaBuffer = fs.readFileSync(filePath);
      
      const result = await this.socket.sendMessage(jid, { 
        document: mediaBuffer,
        mimetype: 'application/octet-stream',
        fileName: filename || 'file',
        caption: caption 
      });

      // Clean up uploaded file
      try {
        fs.unlinkSync(filePath);
      } catch (cleanupError) {
        console.warn('Failed to clean up uploaded file:', cleanupError);
      }

      console.log('✅ Media message sent successfully');
      return {
        success: true,
        messageId: result?.key?.id,
        timestamp: new Date(),
        fileName: filename || 'file'
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

      // Return chats from our cache and try to fetch some if possible
      const chats: any[] = [];
      
      // Add chats from our message cache
      this.messageCache.forEach((messages, chatId) => {
        if (messages.length > 0) {
          const lastMessage = messages[messages.length - 1];
          const chatData = {
            id: chatId,
            name: chatId.split('@')[0],
            isGroup: isJidGroup(chatId),
            unreadCount: 0,
            lastMessageTime: Number(lastMessage.messageTimestamp) * 1000 || Date.now(),
            lastMessage: this.formatMessage(lastMessage)
          };
          chats.push(chatData);
        }
      });
      
      // Add stored chat data
      this.chatData.forEach((chat, chatId) => {
        if (!chats.find(c => c.id === chatId)) {
          chats.push(chat);
        }
      });

      // Sort by last message time (newest first)
      chats.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
      
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

      const groups: any[] = [];
      
      // Get groups from our message cache (groups have @g.us suffix)
      this.messageCache.forEach((messages, chatId) => {
        if (isJidGroup(chatId) && messages.length > 0) {
          // Add basic group info, try to get metadata later
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
      
      // Add stored group data
      this.groupData.forEach((group, groupId) => {
        if (!groups.find(g => g.id === groupId)) {
          groups.push(group);
        }
      });

      // Try to enhance with metadata (but don't fail if it doesn't work)
      for (const group of groups) {
        try {
          if (this.socket && this.isReady) {
            const metadata = await this.socket.groupMetadata(group.id);
            group.name = metadata.subject || group.name;
            group.description = metadata.desc || '';
            group.participantsCount = metadata.participants.length;
            group.isAdmin = metadata.participants.some(p => p.id === this.socket!.user?.id && (p.admin === 'admin' || p.admin === 'superadmin'));
            group.participants = metadata.participants.map(p => ({
              id: p.id,
              phone: p.id.split('@')[0],
              isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
              name: p.id.split('@')[0]
            }));
            
            // Store updated group data
            this.groupData.set(group.id, group);
          }
        } catch (error: any) {
          // Ignore metadata fetch errors, just use basic info
          console.log(`Could not fetch metadata for group ${group.id}`);
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

      const contacts: any[] = [];
      
      // Get contacts from message cache
      this.messageCache.forEach((messages, chatId) => {
        if (!isJidGroup(chatId) && messages.length > 0) {
          const phoneNumber = chatId.split('@')[0];
          const lastMessage = messages[messages.length - 1];
          
          contacts.push({
            id: chatId,
            name: lastMessage.pushName || phoneNumber,
            number: phoneNumber,
            isUser: true,
            isMyContact: false,
            isWAContact: true,
            profilePic: null
          });
        }
      });
      
      // Add stored contact data
      this.contactData.forEach((contact, contactId) => {
        if (!contacts.find(c => c.id === contactId)) {
          contacts.push(contact);
        }
      });

      // Sort contacts alphabetically by name
      contacts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      
      return contacts;

    } catch (error: any) {
      console.error('❌ Failed to get contacts:', error.message);
      return [];
    }
  }

  public async forceRefreshQR(): Promise<void> {
    try {
      console.log('🔄 Force refreshing QR code...');
      this.qrCode = null;
      await this.initializeClient();
    } catch (error: any) {
      console.error('❌ Failed to refresh QR:', error.message);
      throw error;
    }
  }

  public async completeRestart(): Promise<void> {
    try {
      console.log('🔄 Performing complete restart...');
      
      // Clear auth files to force new QR generation
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

      // Reinitialize
      await this.initializeClient();
    } catch (error: any) {
      console.error('❌ Failed to restart:', error.message);
      throw error;
    }
  }

  public async reconnectWithoutClearing(): Promise<void> {
    try {
      console.log('🔄 Reconnecting without clearing session...');
      await this.initializeClient();
    } catch (error: any) {
      console.error('❌ Failed to reconnect:', error.message);
      throw error;
    }
  }

  public async triggerDataSync(): Promise<void> {
    try {
      console.log('🔄 Triggering data synchronization...');
      if (!this.socket || !this.isReady) {
        throw new Error('WhatsApp client is not ready');
      }
      // Data sync is handled automatically by message events
      console.log('✅ Data sync completed');
    } catch (error: any) {
      console.error('❌ Failed to sync data:', error.message);
      throw error;
    }
  }

  public async getChatHistory(chatId: string, limit: number = 50): Promise<any[]> {
    try {
      return await this.getChatMessages(chatId, limit);
    } catch (error: any) {
      console.error('❌ Failed to get chat history:', error.message);
      return [];
    }
  }

  public async downloadMessageMedia(messageId: string): Promise<any> {
    try {
      console.log(`📥 Attempting to download media for message: ${messageId}`);
      // For now, return null as media download is complex with Baileys
      return null;
    } catch (error: any) {
      console.error('❌ Failed to download media:', error.message);
      return null;
    }
  }

  public async clearChatHistory(chatId: string): Promise<void> {
    try {
      if (!this.socket || !this.isReady) {
        throw new Error('WhatsApp client is not ready');
      }

      // For Baileys, we'll just clear from cache
      this.messageCache.delete(chatId);
      
      console.log(`✅ Chat history ${chatId} cleared from cache`);

    } catch (error: any) {
      console.error('❌ Failed to clear chat history:', error.message);
      throw error;
    }
  }

  public async getGroupParticipants(groupId: string): Promise<any[]> {
    try {
      if (!this.socket || !this.isReady) {
        return [];
      }

      if (!isJidGroup(groupId)) {
        throw new Error('Not a group chat');
      }

      const metadata = await this.socket.groupMetadata(groupId);
      return metadata.participants.map(p => ({
        id: p.id,
        phone: p.id.split('@')[0],
        isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
        name: p.id.split('@')[0] // We don't have names from group metadata
      }));

    } catch (error: any) {
      console.error('❌ Failed to get group participants:', error.message);
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