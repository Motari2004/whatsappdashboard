// Polling configuration
const POLL_INTERVAL = 3000; // 3 seconds
const STATUS_INTERVAL = 10000; // 10 seconds

// DOM elements
const messagesContainer = document.getElementById('messages');
const statusElement = document.getElementById('status');
const unreadBadge = document.getElementById('unreadBadge');
const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendButton');

let currentMessages = [];
let selectedContact = null;

// Fetch messages
async function fetchMessages() {
    try {
        const response = await fetch('/api/whatsapp/messages?limit=100');
        const data = await response.json();
        
        if (data.messages) {
            currentMessages = data.messages;
            renderMessages(data.messages);
            
            // Update unread badge
            if (data.unread > 0) {
                unreadBadge.style.display = 'inline';
                unreadBadge.textContent = data.unread;
            } else {
                unreadBadge.style.display = 'none';
            }
            
            // Enable send if we have messages
            if (data.messages.length > 0) {
                messageInput.disabled = false;
                sendButton.disabled = false;
                
                // Auto-select first contact (if not selected)
                if (!selectedContact) {
                    const firstContact = data.messages[0]?.from_id;
                    if (firstContact) {
                        selectedContact = firstContact;
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error fetching messages:', error);
    }
}

// Render messages
function renderMessages(messages) {
    if (messages.length === 0) {
        messagesContainer.innerHTML = '<div style="text-align:center;color:#666;padding:20px;">📭 No messages yet<br><small>Wait for incoming messages or send one!</small></div>';
        return;
    }
    
    // Group by contact
    const grouped = messages.reduce((acc, msg) => {
        const key = msg.from_id || 'unknown';
        if (!acc[key]) acc[key] = [];
        acc[key].push(msg);
        return acc;
    }, {});
    
    // Show all messages (simplified view)
    const html = messages.map(msg => {
        const sender = msg.from_me ? 'You' : (msg.from_id?.split('@')[0] || 'Unknown');
        return `
            <div class="message ${msg.from_me ? 'sent' : 'received'}">
                <div class="message-content">
                    ${!msg.from_me ? `<div class="message-sender">${sender}</div>` : ''}
                    ${msg.body || '[Media/File]'}
                    <div class="message-time">
                        ${new Date(msg.timestamp * 1000).toLocaleString()}
                        ${msg.from_me ? '• Sent' : ''}
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    messagesContainer.innerHTML = html;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Fetch status
async function fetchStatus() {
    try {
        const response = await fetch('/api/whatsapp/status');
        const data = await response.json();
        
        statusElement.textContent = data.connected ? '✅ Connected' : '❌ Disconnected';
        statusElement.className = `status ${data.connected ? 'connected' : 'disconnected'}`;
        
        // Enable/disable sending
        if (!data.connected) {
            messageInput.disabled = true;
            sendButton.disabled = true;
            messageInput.placeholder = 'WhatsApp not connected...';
        } else {
            messageInput.disabled = false;
            sendButton.disabled = false;
            messageInput.placeholder = 'Type a message...';
        }
    } catch (error) {
        statusElement.textContent = '⚠️ Error';
        statusElement.className = 'status disconnected';
        messageInput.disabled = true;
        sendButton.disabled = true;
    }
}

// Send message
async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text) return;
    
    if (!selectedContact) {
        alert('No contact selected. Wait for an incoming message first.');
        return;
    }
    
    try {
        const response = await fetch('/api/whatsapp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                to: selectedContact, 
                message: text 
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            messageInput.value = '';
            // Refresh messages after sending
            setTimeout(fetchMessages, 500);
        } else {
            alert('Failed to send message: ' + (data.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error sending message:', error);
        alert('Failed to send message');
    }
}

// Initialize
async function init() {
    await fetchStatus();
    await fetchMessages();
    
    // Start polling
    setInterval(fetchMessages, POLL_INTERVAL);
    setInterval(fetchStatus, STATUS_INTERVAL);
    
    // Send on enter key
    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });
    
    sendButton.addEventListener('click', sendMessage);
}

// Start app
init();