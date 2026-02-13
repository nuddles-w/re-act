import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

async function listModels() {
  if (!apiKey) {
    console.error("No API Key found");
    return;
  }
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    // listModels might be under genAI or require a specific client
    // In newer versions of @google/generative-ai, it might not be directly available on genAI.
    // However, we can try to use a model we know exists but check the error or try a simple call.
    
    const models = ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-2.0-flash-exp", "gemini-1.5-flash-8b"];
    
    for (const m of models) {
      try {
        const model = genAI.getGenerativeModel({ model: m });
        console.log(`Checking ${m}...`);
        // We don't want to consume quota, but we want to see if it's "found"
        // Just getting the model object doesn't check existence.
        // We need to make a minimal request.
      } catch (e) {
        console.log(`${m} error: ${e.message}`);
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

listModels();
