// Configuration
const POLL_INTERVAL = 3000; // 3 seconds
const STATUS_INTERVAL = 10000; // 10 seconds

// DOM elements
const messagesContainer = document.getElementById('messages');
const statusElement = document.getElementById('status');
const unreadBadge = document.getElementById('unreadBadge');
const messageCount = document.getElementById('messageCount');
const lastUpdate = document.getElementById('lastUpdate');
const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendButton');

let currentMessages = [];
let selectedContact = null;

// Fetch messages
async function fetchMessages() {
    try {
        const response = await fetch('/api/whatsapp/messages?limit=100');
        const data = await response.json();
        
        if (data.success) {
            currentMessages = data.messages || [];
            renderMessages(currentMessages);
            
            // Update info
            messageCount.textContent = `📊 ${currentMessages.length} messages`;
            lastUpdate.textContent = `Last update: ${new Date().toLocaleTimeString()}`;
            
            // Update unread badge
            if (data.unread > 0) {
                unreadBadge.style.display = 'inline';
                unreadBadge.textContent = data.unread;
            } else {
                unreadBadge.style.display = 'none';
            }
            
            // Enable send if we have messages and connected
            if (currentMessages.length > 0) {
                const statusCheck = await fetch('/api/whatsapp/status');
                const statusData = await statusCheck.json();
                if (statusData.connected) {
                    messageInput.disabled = false;
                    sendButton.disabled = false;
                    
                    // Auto-select first contact
                    if (!selectedContact) {
                        const firstContact = currentMessages[0]?.from_id;
                        if (firstContact && firstContact !== 'me') {
                            selectedContact = firstContact;
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error fetching messages:', error);
        messageCount.textContent = '❌ Error loading';
    }
}

// Render messages
function renderMessages(messages) {
    if (!messages || messages.length === 0) {
        messagesContainer.innerHTML = `
            <div style="text-align:center;color:#666;padding:40px 20px;">
                <div style="font-size:48px;margin-bottom:10px;">📭</div>
                <div>No messages yet</div>
                <div style="font-size:13px;margin-top:5px;color:#999;">
                    Wait for incoming messages or send one
                </div>
            </div>
        `;
        return;
    }
    
    // Show recent messages (last 50)
    const recent = messages.slice(0, 50);
    
    const html = recent.map(msg => {
        const sender = msg.from_me ? 'You' : (msg.from_id?.split('@')[0] || 'Unknown');
        const isSent = msg.from_me || msg.from_id === 'me';
        return `
            <div class="message ${isSent ? 'sent' : 'received'}">
                <div class="message-content">
                    ${!isSent ? `<div class="message-sender">${sender}</div>` : ''}
                    ${msg.body || '[Media/File]'}
                    <div class="message-time">
                        ${new Date(msg.timestamp * 1000).toLocaleString()}
                        ${isSent ? '✓ Sent' : ''}
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
        
        if (data.connected) {
            statusElement.textContent = '✅ Connected';
            statusElement.className = 'status connected';
            messageInput.disabled = false;
            sendButton.disabled = false;
            messageInput.placeholder = 'Type a message...';
        } else {
            statusElement.textContent = data.status === 'error' ? '⚠️ Error' : '❌ Disconnected';
            statusElement.className = `status ${data.status === 'error' ? 'error' : 'disconnected'}`;
            messageInput.disabled = true;
            sendButton.disabled = true;
            messageInput.placeholder = 'WhatsApp not connected...';
        }
    } catch (error) {
        console.error('Error fetching status:', error);
        statusElement.textContent = '⚠️ Error';
        statusElement.className = 'status error';
        messageInput.disabled = true;
        sendButton.disabled = true;
    }
}

// Send message
async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text) return;
    
    if (!selectedContact) {
        // Try to find first contact from messages
        const firstContact = currentMessages.find(m => m.from_id && m.from_id !== 'me');
        if (firstContact) {
            selectedContact = firstContact.from_id;
        } else {
            alert('No contact available. Wait for an incoming message first.');
            return;
        }
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
        alert('Failed to send message. Check console for details.');
    }
}

// Manual refresh button (optional)
async function manualRefresh() {
    await fetchMessages();
    await fetchStatus();
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
    
    // Refresh on visibility change (when tab becomes active)
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            fetchMessages();
            fetchStatus();
        }
    });
    
    console.log('✅ Dashboard initialized');
    console.log(`Polling every ${POLL_INTERVAL/1000} seconds`);
}

// Start app
init();