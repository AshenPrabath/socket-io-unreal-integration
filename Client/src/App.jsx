import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import './App.css';
import GeminiLive from './components/GeminiLive';

const socket = io('http://localhost:3000');

function App() {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [apiKey, setApiKey] = useState('');
  const [showLive, setShowLive] = useState(false);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    socket.on('broadcast_message', (data) => {
      setMessages((prev) => {
        if (prev.length > 0) {
          const lastMsg = prev[prev.length - 1];
          // If the last message is from the same sender, append the text
          // This creates a single conversational bubble instead of word-by-word bubbles
          if (lastMsg.sender === data.sender) {
            const updatedMessages = [...prev];
            updatedMessages[updatedMessages.length - 1] = {
              ...lastMsg,
              text: lastMsg.text + (data.text || "")
            };
            return updatedMessages;
          }
        }
        return [...prev, data];
      });

      // Play audio if present and sender is gemini
      if (data.audio && data.sender === 'gemini') {
        const audio = new Audio(`data:audio/wav;base64,${data.audio}`);
        audio.play().catch(e => console.error("Audio playback failed:", e));
      }
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('broadcast_message');
    };
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (!inputValue.trim()) return;

    socket.emit('web_message', { text: inputValue });
    setInputValue('');
  };

  return (
    <div className="app-container">
      <div className="chat-card">
        <div className="chat-header">
          <h1>Gemini Chat Clone</h1>
          <div className="status-indicator">
            <span className={`dot ${isConnected ? 'connected' : 'disconnected'}`}></span>
            {isConnected ? 'Connected' : 'Disconnected'}
          </div>
        </div>

        <div className="api-key-input-container" style={{ padding: '0 24px 10px' }}>
          <input
            type="password"
            placeholder="Enter Gemini API Key (for Live Mode)"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="chat-input"
            style={{ fontSize: '0.8rem', padding: '8px 12px' }}
          />
          <button
            className="btn btn-reset"
            style={{ marginLeft: '10px', fontSize: '0.8rem' }}
            onClick={() => setShowLive(!showLive)}
          >
            {showLive ? 'Hide Live' : 'Show Live'}
          </button>
        </div>

        {showLive && <GeminiLive socket={socket} apiKey={apiKey} />}

        <div className="messages-list">
          {messages.length === 0 && (
            <div style={{ textAlign: 'center', marginTop: '40px', color: '#64748b' }}>
              Start a conversation with Gemini...
            </div>
          )}
          {messages.map((msg, index) => (
            <div key={index} className={`message ${msg.sender}`}>
              <div className="message-sender">{msg.sender}</div>
              <div className="message-text">{msg.text}</div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <form className="chat-input-area" onSubmit={handleSendMessage}>
          <input
            type="text"
            className="chat-input"
            placeholder="Type your message..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
          />
          <button type="submit" className="send-button" disabled={!isConnected || !inputValue.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

export default App;
