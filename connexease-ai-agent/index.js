// index.js (UPDATED with new Tailwind CSS Dashboard)
require('dotenv').config();
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');

// 1. Initialize App & AI
const app = express();
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-latest" });
let knowledgeBase = '';

// --- In-memory store for the last 50 messages ---
const receivedMessages = [];

// --- JWT Authentication, IP Allowlist, Signature Verification ---
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
        if (receivedMessages.length > 0) receivedMessages[0].status = '❌ FAILED (IP Block)';
        res.status(403).send('Forbidden: IP address not allowed.');
    }
}

function verifyConnexeaseSignature(req, res, next) {
    const signature = req.headers['x-connexease-webhook-sign'];
    if (!signature) {
        if (receivedMessages.length > 0) receivedMessages[0].status = '❌ FAILED (Missing)';
        return res.status(403).send('Signature missing.');
    }
    const channelUuid = req.body.channel?.uuid;
    if (!channelUuid) {
        if (receivedMessages.length > 0) receivedMessages[0].status = '❌ FAILED (Bad Payload)';
        return res.status(400).send('Invalid payload for signature check.');
    }
    const secret = process.env.CONNEXEASE_WEBHOOK_SECRET;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(channelUuid, 'utf-8');
    const expectedSignature = hmac.digest('base64');

    // --- ADD THESE TWO LINES FOR DEBUGGING ---
    console.log(`Received Signature:  |${signature}|`);
    console.log(`Generated Signature: |${expectedSignature}|`);
    // -----------------------------------------

    if (signature !== expectedSignature) {
        if (receivedMessages.length > 0) {
            receivedMessages[0].status = '❌ FAILED (Mismatch)';
        }
        console.error("Webhook signature verification FAILED!");
        return res.status(403).send('Invalid signature.');
    }
    console.log("Webhook signature verified successfully.");
    next();
}

// --- AI and Connexease Reply Functions ---
async function getAIResponse(userMessage) {
    if (!knowledgeBase) {
        knowledgeBase = await fs.readFile(path.join(__dirname, 'knowledgebase.txt'), 'utf-8');
    }
    const fullPrompt = `You are a helpful customer service assistant for a network of clinics called Climed. You must answer user questions based ONLY on the information provided in the following knowledge base. Do not make up any information. If the answer is not in the knowledge base, politely state that you do not have that information and a human agent will assist them shortly. Your answers must be in TURKISH. --- KNOWLEDGE BASE START --- ${knowledgeBase} --- KNOWLEDGE BASE END --- User Question: "${userMessage}"`;
    try {
        const result = await model.generateContent(fullPrompt);
        return result.response.text();
    } catch (error) {
        console.error("Error getting AI response:", error);
        return "Üzgünüm, talebinizi işlerken bir sorun oluştu. En kısa sürede bir temsilcimiz size yardımcı olacaktır.";
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

// --- Middleware to log all incoming messages for the dashboard ---
function logMessageForDashboard(req, res, next) {
    const hookType = req.body.hook;
    const payload = req.body.payload;
    if (hookType === 'message.created' || hookType === 'conversation.created') {
        const messageContent = payload.content || payload.messages?.content;
        const customer = payload.customer || payload.messages?.customer;
        if (messageContent) {
            const messageData = {
                from: customer?.name || customer?.phone_number || 'Unknown',
                content: messageContent,
                timestamp: new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }),
                status: 'Pending'
            };
            receivedMessages.unshift(messageData);
            if (receivedMessages.length > 50) receivedMessages.pop();
        }
    }
    next();
}

// --- UPDATED Dashboard Endpoint with New Design ---
app.get('/dashboard', (req, res) => {
    const messagesHtml = receivedMessages.map(msg => {
        let statusIcon, statusColor, statusText;
        switch (msg.status) {
            case '✅ Verified':
                statusIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4"><path d="M20 6 9 17l-5-5"></path></svg>`;
                statusColor = 'text-green-400';
                statusText = 'Verified';
                break;
            case '❌ FAILED (Mismatch)':
            case '❌ FAILED (Missing)':
            case '❌ FAILED (Bad Payload)':
            case '❌ FAILED (IP Block)':
                statusIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>`;
                statusColor = 'text-red-400';
                statusText = 'Failed';
                break;
            default:
                statusIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4"><path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"></path></svg>`;
                statusColor = 'text-yellow-400';
                statusText = 'Processing';
                break;
        }

        return `
            <div class="relative flex items-start sm:items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 mb-4 flex-col sm:flex-row">
              <div class="pl-3 flex-grow mb-2 sm:mb-0">
                <h3 class="text-base font-medium tracking-tight text-white">${msg.content}</h3>
                <div class="mt-1 flex items-center gap-3 text-xs text-neutral-400">
                  <span>From: ${msg.from}</span>
                  <span>•</span>
                  <span>${msg.timestamp}</span>
                </div>
              </div>
              <div class="flex items-center gap-2 text-sm ${statusColor} pl-3 sm:pl-0">
                ${statusIcon}
                <span class="font-mono text-xs">${statusText}</span>
              </div>
            </div>`;
    }).join('');

    const dashboardHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Message Dashboard</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
        <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            .font-manrope { font-family: 'Manrope', sans-serif; }
            @keyframes gradientFlow { 0% {background-position: 0% 50%;} 50% {background-position: 100% 50%;} 100% {background-position: 0% 50%;} }
            .animate-gradient { background-size: 200% 200%; animation: gradientFlow 3s ease-in-out infinite; }
        </style>
    </head>
    <body class="antialiased min-h-screen flex flex-col items-center text-neutral-200 bg-gradient-to-tl from-[#030408] to-[#283343] p-6" style="font-family:'Inter', sans-serif;">
        <div class="w-full max-w-4xl text-center mb-12">
            <h1 class="text-4xl md:text-5xl tracking-tight text-white mb-4 font-manrope font-medium">
                Message <span class="bg-gradient-to-r from-[#2a7fff] via-[#0ea5e9] to-[#22d3ee] bg-clip-text text-transparent animate-gradient">Dashboard</span>
            </h1>
            <p class="text-lg md:text-xl text-neutral-400 max-w-2xl mx-auto">
                Real-time log of incoming webhook messages.
            </p>
        </div>
        <div class="w-full max-w-4xl shadow-[0_20px_50px_-10px_rgba(0,0,0,0.6)] relative overflow-hidden border-white/10 border rounded-3xl backdrop-blur-sm">
            <div class="p-8">
                ${messagesHtml || '<p class="text-center text-neutral-400">No messages received yet. Send a message to the WhatsApp number to begin.</p>'}
            </div>
        </div>
    </body>
    </html>`;
    res.send(dashboardHtml);
});


// --- UPDATED Webhook Endpoint ---
app.post('/webhook', logMessageForDashboard, ipAllowlist, (req, res, next) => {
    if (receivedMessages.length > 0) receivedMessages[0].status = 'IP OK';
    verifyConnexeaseSignature(req, res, next);
}, async (req, res) => {
    if (receivedMessages.length > 0) receivedMessages[0].status = '✅ Verified';
    console.log("Webhook received and passed security checks:", JSON.stringify(req.body, null, 2));
    res.status(200).send('Event received');
    const hookType = req.body.hook;
    const payload = req.body.payload;
    if (hookType === 'message.created' && payload.customer && !payload.agent) {
        const userMessage = payload.content;
        const conversationId = payload.conversation_uuid;
        if (userMessage && userMessage.trim() !== "") {
            console.log(`Processing message from customer: "${userMessage}"`);
            const aiReply = await getAIResponse(userMessage);
            await sendConnexeaseReply(conversationId, aiReply);
        } else {
            console.log("Received message without text content, skipping.");
        }
    } else if (hookType === 'conversation.created' && payload.messages?.content) {
        const userMessage = payload.messages.content;
        const conversationId = payload.uuid;
        if (userMessage && userMessage.trim() !== "") {
            console.log(`Processing first message in new conversation: "${userMessage}"`);
            const aiReply = await getAIResponse(userMessage);
            await sendConnexeaseReply(conversationId, aiReply);
        } else {
            console.log("Received new conversation without text content, skipping.");
        }
    }
});


// --- Start Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    try {
        knowledgeBase = await fs.readFile(path.join(__dirname, 'knowledgebase.txt'), 'utf-8');
        console.log('Knowledge base loaded into memory.');
    } catch (error) {
        console.error('Failed to load knowledge base on startup:', error);
    }
    console.log(`Server is running on port ${PORT}`);
});