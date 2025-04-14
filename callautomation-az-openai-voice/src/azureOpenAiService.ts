import WebSocket from 'ws';
import { config } from 'dotenv';
import { LowLevelRTClient, SessionUpdateMessage } from "rt-client";
import { OutStreamingData } from '@azure/communication-call-automation';
import { processQuery } from './ragService';
config();

let ws: WebSocket;

const openAiServiceEndpoint = process.env.AZURE_OPENAI_SERVICE_ENDPOINT || "";
const openAiKey = process.env.AZURE_OPENAI_SERVICE_KEY || "";
const openAiDeploymentModel = process.env.AZURE_OPENAI_DEPLOYMENT_MODEL_NAME || "";

// Enhanced system prompt with database capabilities
const answerPromptSystemTemplate = `You are an AI assistant for a cement company that helps people find information about products, clients, invoices, and regions.
You have access to a database with information about cement products, client details, invoice data, and region information.
When asked about specific products, clients, invoices, or regions, you will provide accurate information based on the database.
Always be helpful, courteous, and precise with information from the database.`;

let realtimeStreaming: LowLevelRTClient;
let currentUserQuery = "";
let inQueryProcessing = false;

export async function sendAudioToExternalAi(data: string) {
    try {
        const audio = data
        if (audio) {
            await realtimeStreaming.send({
                type: "input_audio_buffer.append",
                audio: audio,
            });
        }
    }
    catch (e) {
        console.log(e)
    }
}

export async function startConversation() {
    await startRealtime(openAiServiceEndpoint, openAiKey, openAiDeploymentModel);
}

async function startRealtime(endpoint: string, apiKey: string, deploymentOrModel: string) {
    try {
        realtimeStreaming = new LowLevelRTClient(new URL(endpoint), { key: apiKey }, { deployment: deploymentOrModel });
        console.log("sending session config");
        await realtimeStreaming.send(createConfigMessage());
        console.log("sent");

    } catch (error) {
        console.error("Error during startRealtime:", error);
    }

    setImmediate(async () => {
        try {
            await handleRealtimeMessages();
        } catch (error) {
            console.error('Error handling real-time messages:', error);
        }
    });
}

function createConfigMessage(): SessionUpdateMessage {

    let configMessage: SessionUpdateMessage = {
        type: "session.update",
        session: {
            instructions: answerPromptSystemTemplate,
            voice: "shimmer",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            turn_detection: {
                type: "server_vad",
            },
            input_audio_transcription: {
                model: "whisper-1"
            }
        }
    };

    return configMessage;
}

export async function handleRealtimeMessages() {
    for await (const message of realtimeStreaming.messages()) {
        switch (message.type) {
            case "session.created":
                  console.log("session started with id:-->" + message.session.id);
                  
                  // Send welcome message in French
                await realtimeStreaming.send({
                    type: "conversation.item.create",
                    item: {
                      type: "message",
                      role: "assistant",
                      content: [
                        {
                          type: "text",
                          text: "Bonjour et bienvenue chez notre service d'assistance pour les produits ciments. Je suis votre assistant virtuel. Comment puis-je vous aider aujourd'hui?"
                        }
                      ]
                    }
                  });
                  break;

            case "response.audio_transcript.delta":
                break;
            case "response.audio.delta":
                await receiveAudioForOutbound(message.delta)
                break;
            case "input_audio_buffer.speech_started":
                console.log(`Voice activity detection started at ${message.audio_start_ms} ms`)
                stopAudio();
                break;
            case "conversation.item.input_audio_transcription.completed":
                console.log(`User:- ${message.transcript}`)
                currentUserQuery = message.transcript;
                
                // Process the query through RAG if not already processing
                if (!inQueryProcessing && currentUserQuery) {
                    inQueryProcessing = true;
                    try {
                        // Get database context for the query
                        const ragResponse = await processQuery(currentUserQuery);
                        
                        // If we have relevant context, send it to the model

                        if (ragResponse.context && ragResponse.context !== "No specific database information found for this query.") {
                            console.log(`RAG Context from ${ragResponse.source}:- ${ragResponse.context}`);
                            

                            // Send the context to the model - fixed to use proper item structure
                            await realtimeStreaming.send({
                                type: "conversation.item.create",
                                item: {
                                    type: "message",
                                    role: "system",
                                    content: [
                                        {
                                            type: "input_text",
                                            text: `Here is relevant information from the database: ${ragResponse.context}`
                                        }
                                    ]
                                }
                            });
                        }
                    } catch (error) {
                        console.error('Error processing query through RAG:', error);
                    } finally {
                        inQueryProcessing = false;
                    }
                }
                break;
            case "response.audio_transcript.done":
                console.log(`AI:- ${message.transcript}`)
                break
            case "response.done":
                console.log(message.response.status)
                break;
            default:
                break
        }
    }
}

export async function initWebsocket(socket: WebSocket) {
    ws = socket;
}

async function stopAudio() {
    try {
        const jsonData = OutStreamingData.getStopAudioForOutbound()
        sendMessage(jsonData);
    }
    catch (e) {
        console.log(e)
    }
}

async function receiveAudioForOutbound(data: string) {
    try {
        const jsonData = OutStreamingData.getStreamingDataForOutbound(data)
        sendMessage(jsonData);
    }
    catch (e) {
        console.log(e)
    }
}

async function sendMessage(data:string) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
    } else {
        console.log("socket connection is not open.")
    }
}