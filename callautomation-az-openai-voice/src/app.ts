import { config } from 'dotenv';
import express, { Application, Request, Response, NextFunction } from 'express';
import http from 'http';
import {
    CallAutomationClient,
    AnswerCallOptions,
    AnswerCallResult,
    MediaStreamingOptions,
    CallConnectionProperties
} from "@azure/communication-call-automation";
import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'ws';
import { startConversation, initWebsocket } from './azureOpenAiService';
import { processWebsocketMessageAsync } from './mediaStreamingHandler';

// Load environment variables
config();

// Validate required environment variables
const PORT = process.env.PORT || '8080';
const CONNECTION_STRING = process.env.CONNECTION_STRING;
const CALLBACK_URI = process.env.CALLBACK_URI;

if (!CONNECTION_STRING || !CALLBACK_URI) {
    console.error('Missing required environment variables: CONNECTION_STRING and CALLBACK_URI must be defined');
    process.exit(1);
}

// Initialize Express with proper middleware
const app: Application = express();
app.use(express.json());

// Add request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'production' ? 'An error occurred' : err.message
    });
});

// Create common server for app and websocket
const server = http.createServer(app);

// Azure Communication Services client
let acsClient: CallAutomationClient;
let activeConnections = new Map<string, { callConnectionId: string, ws: WebSocket }>();

/**
 * Initialize Azure Communication Services client
 */
async function createAcsClient(): Promise<void> {
    try {
        acsClient = new CallAutomationClient(CONNECTION_STRING);
        console.log("Initialized ACS Client successfully");
    } catch (error) {
        console.error("Failed to initialize ACS Client:", error);
        throw error; // Re-throw to handle at startup
    }
}

/**
 * Incoming call handler - follows Azure best practices for Call Automation
 */
app.post("/api/incomingCall", async (req: Request, res: Response) => {
    try {
        const events = req.body;
        
        if (!Array.isArray(events) || events.length === 0) {
            return res.status(400).json({ error: 'Invalid request body format' });
        }
        
        const event = events[0];
        const eventData = event.data;

        // Handle EventGrid subscription validation event
        if (event.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
            console.log("Received SubscriptionValidation event");
            return res.status(200).json({
                validationResponse: eventData.validationCode,
            });
        }

        const callerId = eventData.from.rawId;
        const contextId = uuidv4();
        const callbackUri = `${CALLBACK_URI}/api/callbacks/${contextId}?callerId=${callerId}`;
        const incomingCallContext = eventData.incomingCallContext;
        
        // Configure WebSocket URL for media streaming
        const websocketUrl = CALLBACK_URI.replace(/^https:\/\//, 'wss://');
        
        // Configure media streaming with best practices for voice quality
        const mediaStreamingOptions: MediaStreamingOptions = {
            transportUrl: websocketUrl,
            transportType: "websocket",
            contentType: "audio",
            audioChannelType: "unmixed", // Use unmixed for best AI voice processing
            startMediaStreaming: true,
            enableBidirectional: true,
            audioFormat: "Pcm24KMono" // High quality audio format
        };

        const answerCallOptions: AnswerCallOptions = {
            mediaStreamingOptions: mediaStreamingOptions
        };

        console.log(`Answering incoming call from ${callerId} with context ${contextId}`);
        
        const answerCallResult = await acsClient.answerCall(
            incomingCallContext,
            callbackUri,
            answerCallOptions
        );

        const callConnectionId = answerCallResult.callConnectionProperties.callConnectionId;
        console.log(`Call answered successfully. ConnectionId: ${callConnectionId}`);
        
        // Store the call connection ID for later use
        activeConnections.set(contextId, { 
            callConnectionId,
            ws: null // Will be populated when WebSocket connects
        });
        
        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Error during the incoming call event:", error);
        return res.status(500).json({ 
            error: 'Failed to process incoming call',
            message: (error as Error).message
        });
    }
});

/**
 * Call events callback handler with improved error handling
 */
app.post('/api/callbacks/:contextId', async (req: Request, res: Response) => {
    try {
        const contextId = req.params.contextId;
        const events = req.body;
        
        if (!Array.isArray(events) || events.length === 0) {
            return res.status(400).json({ error: 'Invalid event format' });
        }
        
        const event = events[0];
        const eventData = event.data;
        const callConnectionId = eventData.callConnectionId;
        
        console.log(`Event received: ${event.type} for call ${callConnectionId} (Context: ${contextId})`);
        
        // Always respond OK to EventGrid to avoid retries
        res.status(200).json({ received: true });
        
        // Process specific event types
        switch (event.type) {
            case "Microsoft.Communication.CallConnected":
                await handleCallConnected(callConnectionId);
                break;
                
            case "Microsoft.Communication.MediaStreamingStarted":
                console.log(`Media streaming started: ${eventData.mediaStreamingUpdate.contentType}`);
                console.log(`Status: ${eventData.mediaStreamingUpdate.mediaStreamingStatus}`);
                break;
                
            case "Microsoft.Communication.MediaStreamingStopped":
            case "Microsoft.Communication.MediaStreamingFailed":
                console.log(`Media streaming issue: ${event.type}`);
                console.log(`Status: ${eventData.mediaStreamingUpdate?.mediaStreamingStatus || 'unknown'}`);
                if (event.type === "Microsoft.Communication.MediaStreamingFailed") {
                    console.error(`Media streaming failed: ${eventData.resultInformation.message}`);
                    console.error(`Code: ${eventData.resultInformation.code}, Subcode: ${eventData.resultInformation.subCode}`);
                }
                break;
                
            case "Microsoft.Communication.CallDisconnected":
                await handleCallDisconnected(callConnectionId, contextId);
                break;
                
            default:
                console.log(`Unhandled event type: ${event.type}`);
        }
    } catch (error) {
        console.error("Error processing callback:", error);
        // Already sent response to EventGrid, just log the error
    }
});

/**
 * Handle call connected event
 */
async function handleCallConnected(callConnectionId: string): Promise<void> {
    try {
        const callConnectionProperties = await acsClient.getCallConnection(callConnectionId).getCallConnectionProperties();
        console.log(`Call ${callConnectionId} connected successfully`);
        console.log(`Media streaming subscription: ${JSON.stringify(callConnectionProperties.mediaStreamingSubscription)}`);
    } catch (error) {
        console.error(`Error handling call connected event for call ${callConnectionId}:`, error);
    }
}

/**
 * Handle call disconnected event and cleanup resources
 */
async function handleCallDisconnected(callConnectionId: string, contextId: string): Promise<void> {
    try {
        console.log(`Call ${callConnectionId} disconnected`);
        
        // Find and clean up the connection
        for (const [id, connection] of activeConnections.entries()) {
            if (connection.callConnectionId === callConnectionId || id === contextId) {
                // Close the associated WebSocket if it exists
                if (connection.ws && connection.ws.readyState === WebSocket.OPEN) {
                    connection.ws.close(1000, 'Call disconnected');
                }
                
                // Remove from active connections
                activeConnections.delete(id);
                console.log(`Cleaned up resources for call ${callConnectionId}`);
                break;
            }
        }
    } catch (error) {
        console.error(`Error handling call disconnected event for call ${callConnectionId}:`, error);
    }
}

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        activeConnections: activeConnections.size
    });
});

// Root endpoint
app.get('/', (_req: Request, res: Response) => {
    res.send('Azure Communication Services Call Automation with OpenAI Voice');
});

// WebSocket server setup with improved error handling
const wss = new WebSocket.Server({ server });

// Handle WebSocket connections with proper error handling
wss.on('connection', async (ws: WebSocket, req: http.IncomingMessage) => {
    try {
        console.log('WebSocket client connected');
        
        // Connection timeout handling
        const connectionTimeout = setTimeout(() => {
            console.log('WebSocket connection timed out');
            ws.close(1013, 'Connection timeout');
        }, 5000);
        
        // Set up ping/pong for connection health
        const pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
            }
        }, 30000);
        
        // Configure WebSocket and start conversation
        await initWebsocket(ws);
        await startConversation();
        
        // Connection established, clear timeout
        clearTimeout(connectionTimeout);
        
        // Handle WebSocket messages
        ws.on('message', async (packetData: Buffer) => {
            try {
                if (ws.readyState === WebSocket.OPEN) {
                    await processWebsocketMessageAsync(packetData);
                } else {
                    console.warn(`Cannot process message, WebSocket state: ${ws.readyState}`);
                }
            } catch (error) {
                console.error('Error processing WebSocket message:', error);
                // Don't close connection on message processing error
            }
        });
        
        // Handle WebSocket closure
        ws.on('close', (code: number, reason: string) => {
            console.log(`WebSocket closed: Code ${code} - ${reason || 'No reason provided'}`);
            clearInterval(pingInterval);
        });
        
        // Handle WebSocket errors
        ws.on('error', (error: Error) => {
            console.error('WebSocket error:', error);
            clearInterval(pingInterval);
        });
        
        // Handle pong responses (connection health)
        ws.on('pong', () => {
            // Connection is alive
        });
    } catch (error) {
        console.error('Error handling WebSocket connection:', error);
        ws.close(1011, 'Server error during connection setup');
    }
});

// Start the server with proper error handling
async function startServer(): Promise<void> {
    try {
        await createAcsClient();
        
        server.listen(PORT, () => {
            console.log(`Server listening on port ${PORT}`);
            console.log(`WebSocket server running on port ${PORT}`);
        });
        
        // Handle graceful shutdown
        setupGracefulShutdown();
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown handling
function setupGracefulShutdown(): void {
    let shuttingDown = false;
    
    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        
        console.log('Server shutting down...');
        
        // Close all active WebSocket connections
        wss.clients.forEach((client) => {
            client.close(1001, 'Server shutting down');
        });
        
        // Close the HTTP server
        server.close(() => {
            console.log('HTTP server closed');
            process.exit(0);
        });
        
        // Force exit after timeout
        setTimeout(() => {
            console.error('Forced shutdown after timeout');
            process.exit(1);
        }, 10000);
    };
    
    // Listen for termination signals
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('uncaughtException', (error) => {
        console.error('Uncaught exception:', error);
        shutdown();
    });
}

// Start the server
startServer();