import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import './App.css';

const socket = io('http://localhost:3000');

function App() {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isConnected, setIsConnected] = useState(socket.connected);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    socket.on('broadcast_message', (data) => {
      setMessages((prev) => [...prev, data]);

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
