// index.js (UPDATED for Agent-Assist Dashboard with WebSockets)
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');

// --- 1. INITIALIZATION ---
const app = express();
const server = http.createServer(app); // Express app will run on an HTTP server
const wss = new WebSocket.Server({ server }); // WebSocket server will share the same server

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
let knowledgeBase = '';

// --- In-memory store for conversations (more advanced than just messages) ---
// We'll store conversations keyed by their ID
const conversations = new Map();

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// --- 2. WEBSOCKET LOGIC ---
wss.on('connection', ws => {
    console.log('Dashboard client connected via WebSocket');
    ws.on('close', () => console.log('Dashboard client disconnected'));
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
        console.log("Successfully fetched new token.");
        return connexeaseToken;
    } catch (error) {
        console.error("FATAL: Could not get Connexease JWT.", error.response?.data);
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

// This is the permanent function based on Connexease's instructions.
function verifyConnexeaseSignature(req, res, next) {
    const signature = req.headers['x-connexease-webhook-sign'];
    const secret = process.env.CONNEXEASE_WEBHOOK_SECRET;

    // Connexease has confirmed they send the raw secret, not a signature.
    // So, we will check if the 'signature' header matches our secret.
    if (signature !== secret) {
        console.error("Verification FAILED: The value in X-Connexease-Webhook-Sign does not match the secret key.");
        return res.status(403).send('Invalid signature.');
    }

    // If the check passes, we proceed.
    console.log("Verification PASSED (matching raw secret key as requested by Connexease).");
    next();
}

async function getAIResponse(userMessage) {
    if (!knowledgeBase) {
        knowledgeBase = await fs.readFile(path.join(__dirname, 'knowledgebase.txt'), 'utf-8');
    }
    const fullPrompt = `You are an AI assistant suggesting replies for a human agent. Based on the user's message, provide a helpful and concise response. USER MESSAGE: "${userMessage}" --- KNOWLEDGE BASE: ${knowledgeBase} --- SUGGESTED RESPONSE (in TURKISH):`;
    try {
        const result = await model.generateContent(fullPrompt);
        return result.response.text();
    } catch (error) {
        console.error("Error getting AI response:", error);
        return "Sorry, I couldn't generate a suggestion.";
    }
}

async function sendConnexeaseReply(conversationId, messageText) {
    const token = await getConnexeaseToken();
    if (!token) return;
    const url = `${process.env.CONNEXEASE_API_URL}/api/v1/conversations/${conversationId}/messages`;
    const payload = { message: { content: messageText, private: false } };
    const headers = { 'Content-Type': 'application/json', 'api_access_token': token };
    try {
        await axios.post(url, payload, { headers });
        console.log(`Successfully sent reply to conversation ${conversationId}`);
    } catch (error) {
        console.error("Error sending Connexease reply:", error.response?.data);
    }
}

// --- 4. WEBHOOK HANDLER (UPDATED TO STORE & BROADCAST) ---
app.post('/webhook', ipAllowlist, verifyConnexeaseSignature, async (req, res) => {
    res.status(200).send('Event received'); // Acknowledge immediately

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
        return; // We don't care about other event types for now
    }

    if (!message || !message.content) return;

    // Store the message
    if (!conversations.has(conversationId)) {
        conversations.set(conversationId, {
            id: conversationId,
            customer: payload.customer || payload.messages?.customer,
            messages: []
        });
    }
    const conversation = conversations.get(conversationId);
    conversation.messages.push(message);

    // Broadcast the new message to all connected dashboards
    broadcast({ type: 'newMessage', payload: { conversationId, message, customer: conversation.customer } });

    // Generate AI suggestion and broadcast it
    const aiSuggestion = await getAIResponse(message.content);
    broadcast({ type: 'aiSuggestion', payload: { conversationId, suggestion: aiSuggestion } });
});

// --- 5. API ENDPOINTS FOR THE DASHBOARD ---
// Endpoint to get the list of conversations
app.get('/api/conversations', (req, res) => {
    const convoList = Array.from(conversations.values()).map(c => ({
        id: c.id,
        name: c.customer?.name || c.customer?.phone_number || 'Unknown',
        lastMessage: c.messages[c.messages.length - 1]?.content.substring(0, 30) + '...' || 'No messages yet'
    }));
    res.json(convoList);
});

// Endpoint to get the messages for a specific conversation
app.get('/api/conversations/:id', (req, res) => {
    const conversation = conversations.get(req.params.id);
    if (conversation) {
        res.json(conversation.messages);
    } else {
        res.status(404).send('Conversation not found');
    }
});

// --- 6. THE NEW DASHBOARD FRONT-END ---
app.get('/dashboard', (req, res) => {
    const dashboardHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Agent-Assist Dashboard</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
            body { font-family: 'Inter', sans-serif; }
            .message-bubble-in { animation: messageSlideIn 0.3s ease-out forwards; }
            @keyframes messageSlideIn { 0% { transform: translateY(10px); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }
            ::-webkit-scrollbar { width: 4px; }
            ::-webkit-scrollbar-track { background: transparent; }
            ::-webkit-scrollbar-thumb { background: #4a5568; border-radius: 2px; }
        </style>
    </head>
    <body class="bg-gray-900 text-gray-200 flex h-screen">

        <div id="chat-list-pane" class="w-1/4 bg-gray-950 border-r border-gray-800 flex flex-col">
            <div class="p-4 border-b border-gray-800">
                <h1 class="text-xl font-bold">Active Chats</h1>
            </div>
            <div id="chat-list-container" class="flex-grow overflow-y-auto">
                </div>
        </div>

        <div id="chat-history-pane" class="w-2/4 flex flex-col bg-gray-900">
            <div id="chat-header" class="p-4 border-b border-gray-800 text-center text-gray-500">Select a chat to view messages</div>
            <div id="message-container" class="flex-grow p-6 overflow-y-auto flex flex-col-reverse">
                <div id="messages" class="space-y-4">
                    </div>
            </div>
        </div>

        <div class="w-1/4 bg-gray-950 border-l border-gray-800 flex flex-col">
            <div class="p-4 border-b border-gray-800">
                <h2 class="text-xl font-bold">AI Assistant</h2>
            </div>
            <div class="flex-grow p-4 overflow-y-auto" id="ai-suggestions-container">
                 </div>
        </div>

    <script>
        const chatListContainer = document.getElementById('chat-list-container');
        const messageContainer = document.getElementById('messages');
        const aiSuggestionsContainer = document.getElementById('ai-suggestions-container');
        const chatHeader = document.getElementById('chat-header');
        let activeConversationId = null;

        // --- WebSocket Connection ---
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(\`\${wsProtocol}//\${window.location.host}\`);

        ws.onopen = () => console.log('WebSocket connection established');
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            console.log('Received from WS:', data);

            if (data.type === 'newMessage') {
                updateChatList(data.payload.conversationId, data.payload.customer, data.payload.message);
                if (data.payload.conversationId === activeConversationId) {
                    appendMessage(data.payload.message);
                }
            } else if (data.type === 'aiSuggestion' && data.payload.conversationId === activeConversationId) {
                 displayAiSuggestion(data.payload.suggestion);
            }
        };
        ws.onclose = () => console.log('WebSocket connection closed');


        // --- UI Functions ---
        async function loadConversations() {
            const response = await fetch('/api/conversations');
            const conversations = await response.json();
            chatListContainer.innerHTML = '';
            conversations.forEach(convo => {
                const convoEl = document.createElement('div');
                convoEl.className = 'p-4 border-b border-gray-800 cursor-pointer hover:bg-gray-800';
                convoEl.id = \`convo-\${convo.id}\`;
                convoEl.innerHTML = \`
                    <p class="font-semibold">\${convo.name}</p>
                    <p class="text-smult text-gray-400 truncate">\${convo.lastMessage}</p>
                \`;
                convoEl.onclick = () => loadConversationMessages(convo.id, convo.name);
                chatListContainer.appendChild(convoEl);
            });
        }

        async function loadConversationMessages(convoId, name) {
            if (activeConversationId) {
                document.getElementById(\`convo-\${activeConversationId}\`)?.classList.remove('bg-blue-900/50');
            }
            activeConversationId = convoId;
            document.getElementById(\`convo-\${convoId}\`)?.classList.add('bg-blue-900/50');

            chatHeader.innerHTML = \`<h2 class="text-lg font-semibold text-white">\${name}</h2>\`;
            messageContainer.innerHTML = '<p class="text-center text-gray-506">' +
                                       'Loading messages...</p>';
            aiSuggestionsContainer.innerHTML = '';
            
            const response = await fetch(\`/api/conversations/\${convoId}\`);
            const messages = await response.json();
            messageContainer.innerHTML = '';
            messages.forEach(appendMessage);
        }

        function appendMessage(message) {
            const messageEl = document.createElement('div');
            if (message.sender === 'customer') {
                messageEl.className = 'flex justify-start';
                messageEl.innerHTML = \`
                    <div class="bg-gray-700 rounded-lg p-3 max-w-lg">
                        <p class="text-sm">\${message.content}</p>
                        <p class="text-xs text-gray-400 text-right mt-1">\${message.timestamp}</p>
                    </div>
                \`;
            } else { // For human agent replies (not implemented yet, but for future)
                 messageEl.className = 'flex justify-end';
                 messageEl.innerHTML = \`... // Agent message style\`;
            }
            messageContainer.appendChild(messageEl);
        }
        
        function displayAiSuggestion(suggestion) {
            const suggestionHtml = \`
                <div class="flex flex-col space-y-3 message-bubble-in">
                    <div class="flex items-start">
                        <div class="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs mr-2 font-bold">AI</div>
                        <div class="bg-gray-800 rounded-lg rounded-tl-none p-3 max-w-[80%] shadow-md">
                            <p class="text-gray-300 text-sm">\${suggestion}</p>
                        </div>
                    </div>
                </div>
            \`;
            aiSuggestionsContainer.innerHTML = suggestionHtml;
        }

        function updateChatList(convoId, customer, message) {
                let convoEl = document.getElementById(\`convo-\${convoId}\`);
            if (!convoEl) {
                 // New conversation, add it to the top
                 convoEl = document.createElement('div');
                 convoEl.className = 'p-4 border-b border-gray-800 cursor-pointer hover:bg-gray-800';
                 convoEl.id = \`convo-\${convoId}\`;
                 convoEl.onclick = () => loadConversationMessages(convoId, customer.name || customer.phone_number);
                 chatListContainer.prepend(convoEl);
            }
            // Update content and move to top
            convoEl.innerHTML = \`
                <p class="font-semibold">\${customer.name || customer.phone_number || 'Unknown'}</p>
                <p class="text-sm text-gray-400 truncate">\${message.content.substring(0, 30)}...</p>
            \`;
            chatListContainer.prepend(convoEl);
        }

        // Initial load
        loadConversations();
    </script>
    </body>
    </html>
    `;
    res.send(dashboardHtml);
});


// --- 7. START SERVER ---
// We use server.listen instead of app.listen to handle both HTTP and WebSocket traffic
server.listen(process.env.PORT || 3000, async () => {
    try {
        knowledgeBase = await fs.readFile(path.join(__dirname, 'knowledgebase.txt'), 'utf-8');
        console.log('Knowledge base loaded.');
    } catch (error) {
        console.error('Failed to load knowledge base on startup:', error);
    }
    console.log(`Server is running on port ${process.env.PORT || 3000}`);
});