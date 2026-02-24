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
      // Get response from Gemini
      const result = await model.generateContent(userMessage);
      const aiResponse = result.response.text();

      console.log(`Gemini says: ${aiResponse}`);

      // Emit to everyone (Web and Unreal)
      io.emit("broadcast_message", { sender: "gemini", text: aiResponse });

      // Specifically for Unreal's original format
      io.emit("chat_response", { text: `Gemini: ${aiResponse}` });

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

