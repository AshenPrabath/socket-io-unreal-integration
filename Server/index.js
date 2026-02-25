require("dotenv").config();
const { Server } = require("socket.io");
const { createServer } = require("http");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

// Configure Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

io.on("connection", (socket) => {
  console.log(`>>> Connection established: ${socket.id}`);

  // Handle messages from Web Client
  socket.on("web_message", async (data) => {
    const userMessage = data.text;
    console.log(`Web Client says: ${userMessage}`);

    // Emit to everyone (Web and Unreal)
    io.emit("broadcast_message", { sender: "user", text: userMessage });

    // Specifically for Unreal's bound events if it's listening to 'chat_response'
    // This ensures both input and output are seen by Unreal
    io.emit("chat_response", { text: `User: ${userMessage}` });

    try {
      // Get response from Gemini with native audio modality request
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: {
          // Requesting both text and audio modalities
          // Note: Some SDK versions might use different keys, but this is the standard for multimodal
          responseModalities: ["text", "audio"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Aoide" // A pleasant standard voice
              }
            }
          }
        }
      });

      const response = await result.response;
      let aiText = "";
      let audioData = null;

      // Extract text and audio from parts
      if (response.candidates && response.candidates[0].content.parts) {
        for (const part of response.candidates[0].content.parts) {
          if (part.text) aiText += part.text;
          if (part.inlineData && part.inlineData.mimeType && part.inlineData.mimeType.startsWith("audio/")) {
            audioData = part.inlineData.data; // Base64
          }
        }
      }

      console.log(`Gemini says: ${aiText.substring(0, 50)}... ${audioData ? "(Audio generated)" : "(No audio)"}`);

      // Emit to everyone (Web and Unreal)
      io.emit("broadcast_message", {
        sender: "gemini",
        text: aiText,
        audio: audioData
      });

      // Specifically for Unreal's bound events
      io.emit("chat_response", {
        text: `Gemini: ${aiText}`,
        audio: audioData
      });

    } catch (error) {

      console.error("Error calling Gemini AI:", error);
      io.emit("broadcast_message", { sender: "system", text: "Error: Failed to get AI response." });
    }
  });

  // Handle messages from Gemini Live (Client-side)
  socket.on("live_message", (data) => {
    const sender = data.sender || "gemini";
    console.log(`${sender} (Live): ${data.text}`);

    // Broadcast to everyone as a 'live' message
    io.emit("broadcast_message", {
      sender: sender,
      text: data.text,
      isLive: true
    });

    // Also notify Unreal with a formatted string
    io.emit("chat_response", { text: `${sender === 'user' ? 'User' : 'Gemini'} (Live): ${data.text}` });
  });

  // Keep compatibility for Unreal's original 'send_message'
  socket.on("send_message", (data) => {
    console.log(`Unreal says: ${data}`);
    // Emit what unreal said to everyone
    io.emit("broadcast_message", { sender: "unreal", text: data });
  });

  socket.on("disconnect", () => {
    console.log(`<<< Disconnected: ${socket.id}`);
  });
});

const PORT = 3000;
httpServer.listen(PORT, () => {
  console.log(`Server starting on http://localhost:${PORT}`);
});

