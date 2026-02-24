require("dotenv").config();
const { Server } = require("socket.io");
const { createServer } = require("http");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require("express");
const path = require("path");
const fs = require("fs-extra");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

// Ensure audios directory exists
const audiosDir = path.join(__dirname, "audios");
fs.ensureDirSync(audiosDir);

// Serve audios folder as static
app.use("/audios", express.static(audiosDir));

// Configure Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-3-flash-preview", // Gemini 2.0 supports native audio output
});

io.on("connection", (socket) => {
  console.log(`>>> Connection established: ${socket.id}`);

  // Handle messages from Web Client
  socket.on("web_message", async (data) => {
    const userMessage = data.text;
    console.log(`Web Client says: ${userMessage}`);

    // Broadcast user message
    io.emit("broadcast_message", { sender: "user", text: userMessage });
    io.emit("chat_response", { text: `User: ${userMessage}` });

    try {
      // Correct way to request audio output in Gemini 2.0
      // speechConfig and responseModalities belong inside generationConfig in v1beta
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoife" } },
          },
        },
      });

      const response = await result.response;



      let aiText = "";
      let audioBase64 = null;

      // Iterate through parts to find text and audio
      for (const part of response.candidates[0].content.parts) {
        if (part.text) aiText += part.text;
        if (part.inlineData && part.inlineData.mimeType === "audio/wav") {
          audioBase64 = part.inlineData.data;
        }
      }

      // If no audio was returned in inlineData, Gemini might have returned just text.
      // In some versions, you might need to use a specific speech config.
      // However, the requested flow is to save it as a file.

      let audioUrl = null;
      if (audioBase64) {
        const fileName = `speech_${Date.now()}.wav`;
        const filePath = path.join(audiosDir, fileName);
        await fs.writeFile(filePath, Buffer.from(audioBase64, "base64"));
        audioUrl = `http://localhost:3000/audios/${fileName}`;
      }

      console.log(`Gemini says: ${aiText}`);

      // Emit to everyone
      io.emit("broadcast_message", {
        sender: "gemini",
        text: aiText,
        audioUrl: audioUrl
      });

      io.emit("chat_response", { text: `Gemini: ${aiText}` });
      if (audioUrl) {
        io.emit("audio_response", { url: audioUrl });
      }

    } catch (error) {
      console.error("Error calling Gemini AI:", error);
      io.emit("broadcast_message", { sender: "system", text: "Error: Failed to get AI response." });
    }
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

