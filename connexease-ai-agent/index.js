// index.js (UPDATED with a simple message dashboard)
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

// --- NEW: In-memory store for the last 50 messages ---
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
    console.log(`Incoming request from IP chain: ${clientIpString}`);
    const firstIp = clientIpString.split(',')[0].trim();
    if (firstIp === allowedIp) {
        console.log(`Allowing request as first IP '${firstIp}' matches.`);
        next();
    } else {
        console.warn(`Blocked request from unauthorized IP: ${firstIp}`);
        res.status(403).send('Forbidden: IP address not allowed.');
    }
}

function verifyConnexeaseSignature(req, res, next) {
    const signature = req.headers['x-connexease-webhook-sign'];
    if (!signature) {
        if (receivedMessages.length > 0) {
            receivedMessages[0].signature_ok = '❌ FAILED (Missing)';
        }
        return res.status(403).send('Signature missing.');
    }
    const channelUuid = req.body.channel?.uuid;
    if (!channelUuid) {
        if (receivedMessages.length > 0) {
            receivedMessages[0].signature_ok = '❌ FAILED (Bad Payload)';
        }
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
            receivedMessages[0].signature_ok = '❌ FAILED (Mismatch)';
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

// --- NEW: Middleware to log all incoming messages for the dashboard ---
// This will run for EVERY webhook request, even if security checks fail later.
function logMessageForDashboard(req, res, next) {
    const hookType = req.body.hook;
    const payload = req.body.payload;

    // Check if it's a message we want to log
    if (hookType === 'message.created' || hookType === 'conversation.created') {
        const messageContent = payload.content || payload.messages?.content;
        const customer = payload.customer || payload.messages?.customer;

        if (messageContent) {
            const messageData = {
                from: customer?.name || customer?.phone_number || 'Unknown',
                content: messageContent,
                timestamp: new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }),
                signature_ok: 'Pending' // We don't know the status yet
            };
            // Add the new message to the top of our list
            receivedMessages.unshift(messageData);
            // Keep the list trimmed to the last 50 messages
            if (receivedMessages.length > 50) {
                receivedMessages.pop();
            }
        }
    }
    next(); // IMPORTANT: Always continue to the next middleware
}

// --- NEW: Dashboard Endpoint ---
app.get('/dashboard', (req, res) => {
    let messageHtml = receivedMessages.map(msg => `
        <div class="message">
            <p><strong>From:</strong> ${msg.from}</p>
            <p><strong>Message:</strong> ${msg.content}</p>
            <p><small>Time: ${msg.timestamp} | Signature: ${msg.signature_ok}</small></p>
        </div>
    `).join('');

    if (receivedMessages.length === 0) {
        messageHtml = '<p>No messages received yet.</p>';
    }

    const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Message Dashboard</title>
            <style>
                body { font-family: sans-serif; background-color: #f4f4f9; color: #333; margin: 0; padding: 20px; }
                h1 { text-align: center; color: #444; }
                .container { max-width: 800px; margin: 0 auto; background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                .message { border-bottom: 1px solid #eee; padding: 15px 0; }
                .message:last-child { border-bottom: none; }
                .message p { margin: 5px 0; }
                .message strong { color: #555; }
                small { color: #888; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Received Messages</h1>
                ${messageHtml}
            </div>
        </body>
        </html>
    `;
    res.send(html);
});

// --- UPDATED Webhook Endpoint ---
// We add the new logger function to run FIRST in the chain.
app.post('/webhook', logMessageForDashboard, ipAllowlist, (req, res, next) => {
    // This is a special step to update the dashboard log with the security status
    if (receivedMessages.length > 0) {
        receivedMessages[0].signature_ok = 'IP OK';
    }
    verifyConnexeaseSignature(req, res, next);
}, async (req, res) => {
    // This part only runs if ALL security checks pass.
    if (receivedMessages.length > 0) {
        receivedMessages[0].signature_ok = '✅ Verified';
    }
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