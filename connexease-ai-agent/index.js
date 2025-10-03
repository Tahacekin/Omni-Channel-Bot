// index.js (UPDATED to use OpenAI)
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
// --- UPDATED: Import OpenAI library ---
const OpenAI = require('openai');

// --- 1. INITIALIZATION ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- UPDATED: Initialize OpenAI ---
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

let knowledgeBase = '';

// --- In-memory store for conversations ---
const conversations = new Map();

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// --- 2. WEBSOCKET LOGIC ---
wss.on('connection', ws => {
    console.log('Agent-Assist Dashboard connected');
    ws.on('close', () => console.log('Agent-Assist Dashboard disconnected'));
});

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// --- 3. SECURITY & API MIDDLEWARE ---
let connexeaseToken = null;
let tokenExpiresAt = null;

async function getConnexeaseToken() {
    if (connexeaseToken && tokenExpiresAt && new Date() < tokenExpiresAt) {
        return connexeaseToken;
    }
    console.log("Fetching new Connexease token...");
    try {
        const response = await axios.post(`${process.env.CONNEXEASE_API_URL}/jwt/`, {
            username: process.env.CONNEXEASE_USERNAME,
            password: process.env.CONNEXEASE_PASSWORD
        });
        connexeaseToken = response.data.token;
        tokenExpiresAt = new Date(new Date().getTime() + 23.5 * 60 * 60 * 1000);
        console.log("Connexease token refreshed successfully.");
        return connexeaseToken;
    } catch (error) {
        console.error("FATAL: Could not get Connexease JWT:", error.response?.data);
        return null;
    }
}

function ipAllowlist(req, res, next) {
    const allowedIp = '34.89.215.92';
    const clientIpString = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const firstIp = clientIpString.split(',')[0].trim();
    
    if (firstIp === allowedIp) {
        next();
    } else {
        console.warn(`Blocked request from unauthorized IP: ${firstIp}`);
        res.status(403).send('Forbidden: IP address not allowed.');
    }
}

function verifyConnexeaseSignature(req, res, next) {
    const signature = req.headers['x-connexease-webhook-sign'];
    const secret = process.env.CONNEXEASE_WEBHOOK_SECRET;

    if (signature !== secret) {
        console.error("Webhook signature verification FAILED");
        return res.status(403).send('Invalid signature.');
    }

    console.log("Webhook signature verified successfully.");
    next();
}

// --- 4. getAIResponse Function (UPDATED for OpenAI GPT-5 Responses API) ---
async function getAIResponse(userMessage) {
    if (!knowledgeBase) {
        knowledgeBase = await fs.readFile(path.join(__dirname, 'knowledgebase.txt'), 'utf-8');
    }
    
    // GPT-5 Responses API with optimized instructions for agent assistance
    const instructions = `Sen bir müşteri hizmetleri asistanısın. Climed klinikleri için çalışan insan temsilcilerine WhatsApp mesajlarına yanıt önerileri sunuyorsun.

Verilen bilgi bankasına dayanarak, müşterinin sorusu/şikayeti/isteği için profesyonel, yardımcı ve Türkçe bir yanıt önerisi oluştur.

KURALLAR:
1. Sadece bilgi bankasındaki bilgileri kullan
2. Türkçe yanıt ver
3. Kısa ve net ol (50-150 kelime)
4. Profesyonel ama samimi ton kullan
5. Mevcut kliniği/uzmanı/randevu bilgilerini belirt
6. Kopya yapılabilir format kullan

BİLGİ BANKASI:
${knowledgeBase}`;

    try {
        const response = await openai.responses.create({
            model: "gpt-5-nano", // Fast, cost-effective for simple instruction-following
            reasoning: { effort: "minimal" }, // Fastest response time
            text: { verbosity: "low" }, // Concise responses perfect for agents
            instructions: instructions,
            input: `Müşteri mesajı: "${userMessage}"`
        });
        
        return response.output_text || "Müşteri talebi için özel bir yanıt hazırlanması gerekiyor.";
    } catch (error) {
        console.error("Error getting AI response from OpenAI:", error);
        return "Müşteri talebi için özel bir yanıt hazırlanması gerekiyor.";
    }
}

async function sendConnexeaseReply(conversationId, messageText) {
    const token = await getConnexeaseToken();
    if (!token) return;
    
    const url = `${process.env.CONNEXEASE_API_URL}/api/v1/conversations/${conversationId}/messages`;
    const payload = { message: { content: messageText, private: false } };
    const headers = { 
        'Content-Type': 'application/json', 
        'api_access_token': token 
    };
    
    try {
        await axios.post(url, payload, { headers });
        console.log(`Agent reply sent to conversation ${conversationId}`);
    } catch (error) {
        console.error("Error sending agent reply:", error.response?.data);
    }
}

// --- 5. WEBHOOK HANDLER ---
app.post('/webhook', ipAllowlist, verifyConnexeaseSignature, async (req, res) => {
    res.status(200).send('Event received');

    const hookType = req.body.hook;
    const payload = req.body.payload;
    let conversationId, message;

    if (hookType === 'message.created') {
        if (!payload.customer) return; // Ignore agent messages
        conversationId = payload.conversation_uuid;
        message = {
            sender: 'customer',
            content: payload.content,
            timestamp: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
        };
    } else if (hookType === 'conversation.created') {
        conversationId = payload.uuid;
        message = {
            sender: 'customer',
            content: payload.messages?.content,
            timestamp: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
        };
    } else {
        return;
    }

    if (!message || !message.content) return;

    // Store conversation
    if (!conversations.has(conversationId)) {
        conversations.set(conversationId, {
            id: conversationId,
            customer: payload.customer || payload.messages?.customer,
            messages: []
        });
    }
    
    const conversation = conversations.get(conversationId);
    conversation.messages.push(message);

    // Broadcast customer message to dashboard
    broadcast({ 
        type: 'customerMessage', 
        payload: { 
            conversationId, 
            customer: conversation.customer,
            message,
            timestamp: new Date().toISOString()
        } 
    });

    // Generate AI suggestion for agent
    try {
        const aiSuggestion = await getAIResponse(message.content);
        broadcast({ 
            type: 'aiSuggestion', 
            payload: { 
                conversationId, 
                suggestion: aiSuggestion,
                timestamp: new Date().toISOString()
            } 
        });
    } catch (error) {
        console.error("Failed to generate AI suggestion:", error);
    }
});

// --- 6. API ENDPOINTS FOR DASHBOARD ---

// Get all conversations sorted by most recent activity
app.get('/api/conversations', (req, res) => {
    const convoList = Array.from(conversations.values()).map(c => ({
        id: c.id,
        name: c.customer?.name || c.customer?.phone_number || 'Unknown Customer',
        phoneNumber: c.customer?.phone_number,
        lastMessage: c.messages.length > 0 ? c.messages[c.messages.length - 1].content.substring(0, 40) : 'No messages',
        messageCount: c.messages.length,
        lastActivity: c.messages.length > 0 ? c.messages[c.messages.length - 1].timestamp : null
    }));

    // Sort by last activity
    convoList.sort((a, b) => new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0));
    res.json(convoList);
});

// Get specific conversation messages
app.get('/api/conversations/:id', (req, res) => {
    const conversation = conversations.get(req.params.id);
    if (conversation) {
        res.json({
            id: conversation.id,
            customer: conversation.customer,
            messages: conversation.messages
        });
    } else {
        res.status(404).send('Conversation not found');
    }
});

// --- 7. AGENT-ASSIST DASHBOARD ---
app.get('/dashboard', (req, res) => {
    const dashboardHtml = `
    <!DOCTYPE html>
    <html lang="tr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Climed - Agent Assist Dashboard</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
        <style>
            body { font-family: 'Inter', sans-serif; }
            .conversation-item { transition: all 0.2s; }
            .conversation-item:hover { background-color: #374151; }
            .conversation-item.active { background-color: #2563eb; }
            .message-fade-in { animation: fadeIn 0.3s ease-in; }
            @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
            .ai-suggestion { animation: slideIn 0.5s ease-out; }
            @keyframes slideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
            ::-webkit-scrollbar { width: 6px; }
            ::-webkit-scrollbar-track { background: #374151; }
            ::-webkit-scrollbar-thumb { background: #6b7280; border-radius: 3px; }
        </style>
    </head>
    <body class="bg-gray-900 text-gray-100 h-screen flex overflow-hidden">

        <!-- LEFT PANEL: Conversations List -->
        <div class="w-1/4 bg-gray-950 border-r border-gray-700 flex flex-col">
            <div class="p-4 border-b border-gray-700">
                <h1 class="text-xl font-semibold text-blue-400">Conversations</h1>
                <p class="text-sm text-gray-400 mt-1">Climed Customer Service</p>
            </div>
            <div id="conversations-list" class="flex-1 overflow-y-auto">
                <!-- Conversations will be loaded here -->
            </div>
        </div>

        <!-- CENTER PANEL: Chat History -->
        <div class="flex-1 flex flex-col bg-gray-900">
            <div id="chat-header" class="p-4 border-b border-gray-700 bg-gray-800">
                <p class="text-center text-gray-400">Select a conversation to view messages</p>
            </div>
            <div id="chat-messages" class="flex-1 overflow-y-auto p-4 space-y-4">
                <!-- Messages will be loaded here -->
            </div>
        </div>

        <!-- RIGHT PANEL: AI Suggestions -->
        <div class="w-1/3 bg-gray-950 border-l border-gray-700 flex flex-col">
            <div class="p-4 border-b border-gray-700">
                <h2 class="text-lg font-semibold text-green-400">GPT-5 Assistant</h2>
                <p class="text-sm text-gray-400 mt-1">AI-powered suggestions</p>
            </div>
            <div id="ai-suggestions" class="flex-1 overflow-y-auto p-4">
                <!-- AI suggestions will appear here -->
            </div>
            <div class="p-4 border-t border-gray-700 bg-gray-800">
                <button id="refresh-suggestions" class="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded text-sm">
                    Refresh AI Suggestions
                </button>
            </div>
        </div>

    <script>
        let activeConversationId = null;
        let currentCustomerMessage = null;

        // WebSocket connection
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(\`\${wsProtocol}//\${window.location.host}\`);
        
        ws.onopen = () => {
            console.log('Connected to Agent-Assist Dashboard');
            loadConversations();
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            handleDashboardUpdate(data);
        };

        ws.onclose = () => {
            console.log('Dashboard connection lost');
            setTimeout(loadConversations, 5000);
        };

        // Handle real-time updates
        function handleDashboardUpdate(data) {
            if (data.type === 'customerMessage') {
                // Update conversations list
                updateConversationsList(data.payload);
                
                // If viewing this conversation, show the new message
                if (activeConversationId === data.payload.conversationId) {
                    displayCustomerMessage(data.payload.message);
                }

                // Store for potential AI suggestion
                currentCustomerMessage = data.payload.message.content;
                
            } else if (data.type === 'aiSuggestion') {
                // Display AI suggestion
                if (activeConversationId === data.payload.conversationId) {
                    displayAiSuggestion(data.payload.suggestion);
                }
            }
        }

        // Load all conversations
        function loadConversations() {
            fetch('/api/conversations')
                .then(res => res.json())
                .then(conversations => {
                    displayConversations(conversations);
                })
                .catch(err => {
                    console.error('Failed to load conversations:', err);
                    document.getElementById('conversations-list').innerHTML = 
                        '<p class="p-4 text-red-400">Failed to load conversations</p>';
                });
        }

        // Display conversations in left panel
        function displayConversations(conversations) {
            const container = document.getElementById('conversations-list');
            
            if (conversations.length === 0) {
                container.innerHTML = '<p class="p-4 text-gray-400">No conversations yet</p>';
                return;
            }

            container.innerHTML = conversations.map(conv => {
                const isActive = activeConversationId === conv.id;
                return \`
                    <div class="conversation-item \${isActive ? 'active' : ''} p-4 border-b border-gray-700 cursor-pointer" 
                         onclick="selectConversation('\${conv.id}', '\${conv.name}')">
                        <h3 class="font-semibold text-white">\${conv.name}</h3>
                        <p class="text-sm text-gray-400 mt-1 truncate">\${conv.lastMessage}</p>
                        <div class="flex justify-between items-center mt-2">
                            <span class="text-xs text-gray-500">\${conv.messageCount} message(s)</span>
                            <span class="text-xs text-gray-500">\${conv.lastActivity || ''}</span>
                        </div>
                    </div>
                \`;
            }).join('');
        }

        // Update conversations list with new message
        function updateConversationsList(payload) {
            const container = document.getElementById('conversations-list');
            const existingConv = document.querySelector(\`[onclick*="'\${payload.conversationId}'"]\`);
            
            if (existingConv) {
                // Update existing conversation position
                const newConv = document.createElement('div');
                newConv.className = \`conversation-item \${activeConversationId === payload.conversationId ? 'active' : ''} p-4 border-b border-gray-700 cursor-pointer\`;
                newConv.onclick = () => selectConversation(payload.conversationId, payload.customer.name || payload.customer.phone_number);
                newConv.innerHTML = \`
                    <h3 class="font-semibold text-white">\${payload.customer.name || payload.customer.phone_number || 'Unknown Customer'}</h3>
                    <p class="text-sm text-gray-400 mt-1 truncate">\${payload.message.content.substring(0, 40)}...</p>
                    <div class="flex justify-between items-center mt-2">
                        <span class="text-xs text-gray-500">\${payload.message.timestamp}</span>
                    </div>
                \`;
                
                // Remove old and add new at top
                existingConv.remove();
                container.insertBefore(newConv, container.firstChild);
            } else {
                // Add new conversation at top
                loadConversations();
            }
        }

        // Select a conversation
        function selectConversation(conversationId, customerName) {
            activeConversationId = conversationId;
            
            // Update conversation list UI
            document.querySelectorAll('.conversation-item').forEach(item => {
                item.classList.remove('active');
            });
            document.querySelector(\`[onclick*="'\${conversationId}'"]\`)?.classList.add('active');

            // Update chat header
            document.getElementById('chat-header').innerHTML = \`
                <h2 class="text-lg font-semibold text-white">\${customerName}</h2>
                <p class="text-sm text-gray-400">Customer conversation</p>
            \`;

            // Load conversation messages
            loadConversationMessages(conversationId);
        }

        // Load messages for selected conversation
        function loadConversationMessages(conversationId) {
            const container = document.getElementById('chat-messages');
            container.innerHTML = '<p class="text-center text-gray-400">Loading messages...</p>';

            fetch(\`/api/conversations/\${conversationId}\`)
                .then(res => res.json())
                .then(data => {
                    displayConversationMessages(data.messages);
                })
                .catch(err => {
                    console.error('Failed to load messages:', err);
                    container.innerHTML = '<p class="text-center text-red-400">Failed to load messages</p>';
                });
        }

        // Display conversation messages
        function displayConversationMessages(messages) {
            const container = document.getElementById('chat-messages');
            
            if (messages.length === 0) {
                container.innerHTML = '<p class="text-center text-gray-400">No messages yet</p>';
                return;
            }

            container.innerHTML = messages.map(msg => \`
                <div class="flex justify-start">
                    <div class="bg-gray-700 rounded-lg px-4 py-2 max-w-xs message-fade-in">
                        <p class="text-sm">\${msg.content}</p>
                        <p class="text-xs text-gray-400 mt-1 text-right">\${msg.timestamp}</p>
                    </div>
                </div>
            \`).join('');

            // Scroll to bottom
            container.scrollTop = container.scrollHeight;
        }

        // Display customer message (real-time)
        function displayCustomerMessage(message) {
            const container = document.getElementById('chat-messages');
            const messageEl = document.createElement('div');
            messageEl.className = 'flex justify-start message-fade-in';
            messageEl.innerHTML = \`
                <div class="bg-gray-700 rounded-lg px-4 py-2 max-w-xs">
                    <p class="text-sm">\${message.content}</p>
                    <p class="text-xs text-gray-400 mt-1 text-right">\${message.timestamp}</p>
                </div>
            \`;
            container.appendChild(messageEl);
            container.scrollTop = container.scrollHeight;
        }

        // Display AI suggestion
        function displayAiSuggestion(suggestion) {
            const container = document.getElementById('ai-suggestions');
            
            const suggestionEl = document.createElement('div');
            suggestionEl.className = 'ai-suggestion bg-gray-800 rounded-lg p-4 mb-4 border-l-4 border-green-500';
            suggestionEl.innerHTML = \`
                <div class="flex items-center mb-2">
                    <div class="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center mr-2">
                        <span class="text-white text-xs font-bold">AI</span>
                    </div>
                    <span class="text-sm font-semibold text-green-400">GPT-5 Suggested Response:</span>
                </div>
                <p class="text-sm text-gray-200 leading-relaxed">\${suggestion}</p>
                <div class="mt-3 flex space-x-2">
                    <button onclick="copySuggestion('\${suggestion.replace(/'/g, "\\'")}')" 
                            class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-xs">
                        Copy Text
                    </button>
                </div>
            \`;
            
            container.innerHTML = '';
            container.appendChild(suggestionEl);
            
            // Scroll to top
            container.scrollTop = 0;
        }

        // Copy suggestion to clipboard
        function copySuggestion(text) {
            navigator.clipboard.writeText(text).then(() => {
                // Show temporary feedback
                const button = event.target;
                const originalText = button.textContent;
                button.textContent = 'Copied!';
                button.style.background = 'green';
                
                setTimeout(() => {
                    button.textContent = originalText;
                    button.style.background = '';
                }, 1500);
            });
        }

        // Refresh AI suggestions
        document.getElementById('refresh-suggestions').onclick = () => {
            if (currentCustomerMessage) {
                // Trigger new AI generation
                fetch('/api/regenerate-suggestion', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        conversationId: activeConversationId,
                        message: currentCustomerMessage 
                    })
                }).catch(err => console.error('Failed to refresh suggestion:', err));
            }
        };
    </script>
    </body>
    </html>
    `;
    res.send(dashboardHtml);
});

// --- 8. START SERVER ---
server.listen(process.env.PORT || 3000, async () => {
    try {
        knowledgeBase = await fs.readFile(path.join(__dirname, 'knowledgebase.txt'), 'utf-8');
        console.log('✨ GPT-5 Agent-Assist Dashboard is ready!');
        console.log('🤖 Powered by OpenAI GPT-5 Nano');
        console.log('📊 Knowledge base loaded successfully');
    } catch (error) {
        console.error('❌ Failed to load knowledge base:', error);
    }
    console.log(`🚀 Server running on port ${process.env.PORT || 3000}`);
});