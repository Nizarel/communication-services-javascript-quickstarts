import { AzureOpenAI } from "openai";
import "@azure/openai/types";
import { config } from 'dotenv';
import sql from 'mssql';

// Load environment variables
config();

// Connection pool for reuse
let pool: sql.ConnectionPool | null = null;

/**
 * SQL Server connection configuration with Azure best practices
 * - Uses environment variables for connection settings
 * - Enables encryption (required for Azure SQL)
 * - Configures optimal connection pooling
 * - Sets appropriate timeouts for cloud environments
 */
const sqlConfig: sql.config = {
  user: process.env.SQL_USER || '',
  password: process.env.SQL_PASSWORD || '',
  database: process.env.SQL_DATABASE || '',
  server: process.env.SQL_SERVER || '',
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  },
  options: {
    encrypt: true, // Required for Azure SQL
    trustServerCertificate: false, // Best practice for production
    connectTimeout: 30000, // Appropriate for cloud environments
    requestTimeout: 30000,
    // For monitoring in Azure Monitor and SQL insights
    appName: 'CallAutomation-AzOpenAI-Voice'
  }
};

/**
 * Creates and returns a singleton SQL connection pool
 * Following Azure best practices for connection management
 */
async function getConnectionPool(): Promise<sql.ConnectionPool> {
  try {
    if (!pool) {
      console.log('Creating new SQL connection pool...');
      pool = await new sql.ConnectionPool(sqlConfig).connect();
      
      // Handle pool errors with proper logging and reset
      pool.on('error', (err) => {
        console.error('SQL Pool Error:', err);
        pool = null; // Reset the pool on error
      });
      
      console.log('Connected to SQL database');
    }
    return pool;
  } catch (err) {
    console.error('Database connection failed:', err);
    throw err;
  }
}

/**
 * Execute database queries with proper parameter handling and retry logic
 * Following Azure best practices for resilience
 * @param query SQL query string with optional parameterized values
 * @param params Array of parameter values to be sanitized
 */
export async function queryDatabase(query: string, params: any[] = []): Promise<any> {
  const maxRetries = 3;
  let retries = 0;
  let lastError: any;
  
  while (retries < maxRetries) {
    try {
      const pool = await getConnectionPool();
      const request = pool.request();
      
      // Map parameters to request correctly with SQL injection protection
      if (params && params.length > 0 && query.includes('@')) {
        const paramNames = query.match(/@\w+/g) || [];
        
        paramNames.forEach((paramName, index) => {
          if (index < params.length) {
            // Remove @ from paramName
            const name = paramName.substring(1);
            request.input(name, params[index]);
          }
        });
      }
      
      const result = await request.query(query);
      return result.recordset || result;
    } catch (err: any) {
      lastError = err;
      retries++;
      
      // Implement exponential backoff for transient errors
      if (err.code === 'ESOCKET' || err.code === 'ETIMEOUT' || err.code === 'ECONNRESET' || 
          (err.number && (err.number === 10928 || err.number === 10929 || err.number === 40613))) {
        console.warn(`SQL connection error (attempt ${retries}/${maxRetries}): ${err.message}`);
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retries-1))); // True exponential backoff
        
        // Reset the pool if there's a connection issue
        if (pool) {
          try {
            await pool.close();
          } catch (closeErr) {
            console.warn('Error closing pool:', closeErr);
          }
          pool = null;
        }
      } else {
        // For non-connection errors, don't retry
        break;
      }
    }
  }
  
  console.error('Final error executing query after retries:', lastError);
  throw lastError;
}

// Tracking conversation context
interface ConversationEntry {
  timestamp: string;
  query: string;
  queryType: string;
  action: string;
  details: string;
  result?: any;
  naturalLanguageQuery?: string;
}

const conversationContext: ConversationEntry[] = [];

/**
 * Update conversation context with query information
 */
export function updateConversationContext(query: string, queryType: string, result: any, naturalLanguageQuery?: string): void {
  const entry: ConversationEntry = {
    timestamp: new Date().toISOString(),
    query,
    queryType,
    action: queryType.toLowerCase(),
    details: '',
    result,
    naturalLanguageQuery
  };
  
  if (queryType === 'SELECT' && result) {
    entry.action = 'retrieved';
    entry.details = `${Array.isArray(result) ? result.length : 0} records`;
  } else if (['INSERT', 'UPDATE', 'DELETE'].includes(queryType)) {
    entry.action = queryType.toLowerCase() + 'd';
    entry.details = `${result.rowsAffected || 0} records`;
  }
  
  conversationContext.push(entry);
  
  // Limit history for memory management
  if (conversationContext.length > 10) {
    conversationContext.shift();
  }
}

/**
 * Get conversation history
 */
export function getConversationContext(): ConversationEntry[] {
  return [...conversationContext];
}

/**
 * Clean SQL query by removing markdown formatting and code blocks
 * @param sqlText Raw SQL text that might contain markdown formatting
 * @returns Clean SQL query
 */
function cleanSqlQuery(sqlText: string): string {
  // Remove markdown code blocks (```sql ... ```)
  const pattern = /```(?:sql)?\s*([\s\S]*?)\s*```/;
  const matches = pattern.exec(sqlText);
  if (matches && matches[1]) {
    return matches[1].trim();
  }
  
  // If no code blocks found, just return the text as is
  return sqlText.trim();
}

/**
 * Fix common SQL syntax issues to ensure compatibility with SQL Server
 * @param sqlQuery SQL query that might contain incorrect syntax
 * @returns Fixed SQL query compatible with SQL Server
 */
function fixSqlSyntax(sqlQuery: string): string {
  let fixedQuery = sqlQuery;
  
  // Replace LIMIT with TOP
  const limitPattern = /SELECT\s+(.*?)\s+FROM\s+(.*?)\s+LIMIT\s+(\d+)/i;
  if (limitPattern.test(fixedQuery)) {
    fixedQuery = fixedQuery.replace(limitPattern, 'SELECT TOP $3 $1 FROM $2');
    console.log(`Fixed LIMIT syntax: ${fixedQuery}`);
  }
  
  // Replace backticks with square brackets
  fixedQuery = fixedQuery.replace(/`([^`]+)`/g, '[$1]');
  
  return fixedQuery;
}

/**
 * Convert natural language to SQL using Azure OpenAI
 * Following Azure best practices for AI services integration
 */
export async function nlToSql(naturalLanguageQuery: string): Promise<{ sql: string; explanation?: string }> {
  try {
    // Validate environment variables
    if (!process.env.AZURE_OPENAI_SERVICE_KEY || !process.env.AZURE_OPENAI_SERVICE_ENDPOINT) {
      throw new Error("Missing Azure OpenAI configuration. Check environment variables.");
    }

    // Create an Azure OpenAI client - fixed to use proper model and API version
    const openAiClient = new AzureOpenAI({
      apiKey: process.env.AZURE_OPENAI_SERVICE_KEY,
      endpoint: process.env.AZURE_OPENAI_SERVICE_ENDPOINT,
      apiVersion: "2024-10-01-preview"  // Using stable API version
    });

    // Add context from previous interactions
    let contextInfo = "";
    if (conversationContext.length > 0) {
      contextInfo += "\nRecent conversation context:\n";
      // Add the last 3 conversation items for context
      conversationContext.slice(-3).forEach((ctx, i) => {
        contextInfo += `${i+1}. User asked: '${ctx.naturalLanguageQuery || ctx.query}', which resulted in ${ctx.action} ${ctx.details}\n`;
      });
    }

    // Schema definition for the database - crucial for accurate SQL generation
    const schemaContext = `
    Database Schema Definition:
    
    clients table:
      - id (int) NOT NULL PRIMARY KEY
      - name (nvarchar(100)) NOT NULL
      - email (nvarchar(255)) NOT NULL
      - montantfactures (decimal(10, 2)) NULL
      - IsInformed (bit) NULL
      - IsBlocked (bit) NULL
      
    factures table:
      - id (int) NOT NULL PRIMARY KEY
      - NumerFacture (nvarchar(50)) NOT NULL
      - MontantFacture (decimal(10, 2)) NOT NULL
      - DelaiDePaiement (int) NOT NULL
      - DateFacturation (date) NOT NULL
      - DateEcheance (date) NOT NULL
      - clientId (int) NULL FOREIGN KEY REFERENCES clients(id)
      
    ArticleCiments table:
      - Article_Id (int) IDENTITY(1,1) NOT NULL PRIMARY KEY
      - Id_Site (int) NULL
      - Designation (nvarchar(150)) NOT NULL
      - Tarif (decimal(20, 2)) NULL
      - Disponibilité (bit) NULL
      
    Region table:
      - Region_Id (int) NOT NULL PRIMARY KEY
      - Region_Libelle (nvarchar(100)) NULL
      
    Relationships:
    - factures.clientId → clients.id (Many-to-one)
    `;

    // Using Azure OpenAI to generate SQL from natural language
    const response = await openAiClient.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT_MODEL_NAME2 || "gpt-4o",  // Use the compatible model
      messages: [
        {
          role: "system",
          content: `You are an expert SQL developer specializing in SQL Server syntax.
Your task is to convert natural language questions into valid SQL queries that can be executed against a SQL Server database.

${schemaContext}

${contextInfo}

IMPORTANT: Return ONLY the pure SQL statement with no markdown formatting, code blocks, or explanations.

IMPORTANT SQL SYNTAX RULES:
1. This is for SQL Server (NOT MySQL or PostgreSQL)
2. Use TOP instead of LIMIT (e.g., "SELECT TOP 10 * FROM table" not "SELECT * FROM table LIMIT 10")
3. For date functions, use proper SQL Server syntax (e.g., DATEADD, DATEDIFF)
4. Use square brackets [column] for column names with spaces
5. DO NOT use backticks (\`) as they are MySQL syntax and will cause errors in SQL Server

Instructions:
1. Generate only the SQL query without any explanations or comments
2. Use standard SQL Server syntax
3. Include proper table aliases for readability and to avoid ambiguity
4. Create appropriate JOINs when queries involve multiple tables
5. For questions about availability, translate "Disponibilité" column values: 1 = Available, 0 = Not available
6. For date comparisons, use ISO format (YYYY-MM-DD)
7. For aggregate queries (COUNT, SUM, AVG), include proper GROUP BY clauses
8. The queries will be executed directly, so ensure they are valid and safe
9. Use parameterized queries with @param syntax where appropriate`
        },
        {
          role: "user",
          content: naturalLanguageQuery
        }
      ],
      temperature: 0, // Low temperature for more deterministic results
      max_tokens: 800,
      top_p: 0.95,
      frequency_penalty: 0,
      presence_penalty: 0
    });

    let sqlQuery = response.choices[0]?.message?.content?.trim() || "";
    
    // Clean and fix the SQL query
    sqlQuery = cleanSqlQuery(sqlQuery);
    sqlQuery = fixSqlSyntax(sqlQuery);
    
    // Log NL to SQL conversion for debugging
    console.log(`NL2SQL: "${naturalLanguageQuery}" → "${sqlQuery}"`);
    
    return { sql: sqlQuery };
  } catch (error: any) {
    console.error("Error in NL to SQL conversion:", error);
    
    // Enhanced error handling with Azure service-specific responses
    if (error.status === 429) {
      // Rate limit exceeded - implement proper backoff
      throw new Error(`Azure OpenAI rate limit exceeded. Please try again later.`);
    } else if (error.status === 400 && error.message.includes('model')) {
      // Model compatibility issue
      throw new Error(`Model compatibility error: Please check AZURE_OPENAI_DEPLOYMENT_MODEL_NAME2 environment variable.`);
    } else if (error.status === 401 || error.status === 403) {
      // Authentication issues
      throw new Error(`Authentication error with Azure OpenAI. Please check your credentials.`);
    } else if (error.status === 404) {
      // Resource not found
      throw new Error(`Azure OpenAI resource not found. Verify endpoint and deployment.`);
    }
    
    throw new Error(`Failed to convert natural language to SQL: ${error.message}`);
  }
}

/**
 * Format SQL query results as natural language using Azure OpenAI
 */
export async function formatResultsAsNaturalLanguage(
  queryType: string, 
  results: any, 
  naturalLanguageQuery: string
): Promise<string> {
  try {
    // Create an Azure OpenAI client
    const openAiClient = new AzureOpenAI({
      apiKey: process.env.AZURE_OPENAI_SERVICE_KEY || "",
      endpoint: process.env.AZURE_OPENAI_SERVICE_ENDPOINT || "",
      apiVersion: "2024-10-01-preview"
    });

    // Format results for the AI to process
    let formattedResults = "";
    let recordCount = 0;
    
    if (queryType === "SELECT") {
      if (Array.isArray(results)) {
        recordCount = results.length;
        // Limit the amount of data we send to Azure OpenAI for cost and token optimization
        const samplesToSend = results.slice(0, 10);
        formattedResults = JSON.stringify(samplesToSend, null, 2);
        
        if (results.length > 10) {
          formattedResults += `\n\n(Showing 10 of ${results.length} results)`;
        }
      } else {
        formattedResults = "No results found.";
      }
    } else if (["INSERT", "UPDATE", "DELETE"].includes(queryType)) {
      formattedResults = `${queryType} operation affected ${results.rowsAffected || 0} rows.`;
    }

    // Use the standard model, not the realtime preview model
    const response = await openAiClient.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT_MODEL_NAME2 || "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a helpful assistant that converts database query results into natural language summaries.
Your task is to give a clear, concise, and natural-sounding summary of the database query results.

Guidelines:
1. Be conversational and natural in your response
2. Summarize the key findings from the data
3. For empty results, explain that nothing was found for the query
4. For cement products, mention both designation and price
5. For client information, be professional and concise
6. Format currency values appropriately (e.g., "1200.50 DH")
7. Avoid using technical terminology unless necessary
8. IMPORTANT: Respond in the SAME LANGUAGE as the user's original query.
   If the user's query is in French, respond in French.
   If the user's query is in English, respond in English.
   If the user's query is in Arabic, respond in Arabic.`
        },
        {
          role: "user",
          content: `Original query: "${naturalLanguageQuery}"
Query type: ${queryType}
Number of records: ${recordCount}
Results: ${formattedResults}

Please provide a natural language summary of these database results.`
        }
      ],
      temperature: 0.7, // Slightly higher temperature for more natural responses
      max_tokens: 500
    });

    const nlSummary = response.choices[0]?.message?.content?.trim() || "";
    return nlSummary;
  } catch (error: any) {
    console.error("Error formatting results as natural language:", error);
    
    // Enhanced error handling with graceful degradation
    if (error.status === 429) {
      return `Found ${Array.isArray(results) ? results.length : 0} results for your query. (Rate limit reached, detailed summary unavailable)`;
    }
    
    // Fallback to a basic summary if AI fails
    if (Array.isArray(results)) {
      return `Found ${results.length} results for your query.`;
    } else if (["INSERT", "UPDATE", "DELETE"].includes(queryType)) {
      return `Operation complete. ${results.rowsAffected || 0} records affected.`;
    } else {
      return "Query completed, but couldn't generate a summary of the results.";
    }
  }
}

/**
 * Process natural language query end-to-end
 * Implements the full RAG (Retrieval Augmented Generation) pattern
 */
export async function processNaturalLanguageQuery(naturalLanguageQuery: string): Promise<{
  context: string;
  source: string;
}> {
  try {
    // Convert natural language to SQL
    const { sql } = await nlToSql(naturalLanguageQuery);
    
    // Extract query type (SELECT, INSERT, UPDATE, DELETE)
    const queryType = sql.trim().split(/\s+/)[0].toUpperCase();
    
    // Execute the SQL query with retry logic
    const result = await queryDatabase(sql);
    
    // Update conversation context
    updateConversationContext(sql, queryType, result, naturalLanguageQuery);
    
    // Format results as natural language
    const nlResponse = await formatResultsAsNaturalLanguage(queryType, result, naturalLanguageQuery);
    
    // Return context in the format expected by the RAG service
    return {
      context: nlResponse,
      source: "SQL Database"
    };
  } catch (error: any) {
    console.error("Error processing natural language query:", error);
    
    // Return a helpful error message
    return {
      context: `Je n'ai pas pu récupérer les informations demandées. ${error.message}`,
      source: "Error"
    };
  }
}

/**
 * Get product information from database
 */
export async function getProductInfo(productName?: string): Promise<any[]> {
  try {
    let query = 'SELECT * FROM ArticleCiments';
    let result: any[];
    
    if (productName) {
      query += ' WHERE Designation LIKE @productName';
      result = await queryDatabase(query, [`%${productName}%`]);
    } else {
      result = await queryDatabase(query);
    }
    
    updateConversationContext(query, 'SELECT', result);
    return result;
  } catch (error: any) {
    console.error('Error getting product info:', error);
    throw new Error(`Failed to retrieve product information: ${error.message}`);
  }
}

/**
 * Get client information from database
 */
export async function getClientInfo(clientName?: string, clientId?: number): Promise<any[]> {
  try {
    let query = 'SELECT * FROM clients';
    let result: any[];
    
    if (clientName) {
      query += ' WHERE name LIKE @clientName';
      result = await queryDatabase(query, [`%${clientName}%`]);
    } else if (clientId) {
      query += ' WHERE id = @clientId';
      result = await queryDatabase(query, [clientId]);
    } else {
      result = await queryDatabase(query);
    }
    
    updateConversationContext(query, 'SELECT', result);
    return result;
  } catch (error: any) {
    console.error('Error getting client info:', error);
    throw new Error(`Failed to retrieve client information: ${error.message}`);
  }
}

/**
 * Get invoice information from database with optimized joins
 */
export async function getInvoiceInfo(invoiceNumber?: string, clientId?: number): Promise<any[]> {
  try {
    // Using proper table aliases and column selection for performance
    let query = `
      SELECT 
        f.id, f.NumerFacture, f.MontantFacture, 
        f.DelaiDePaiement, f.DateFacturation, f.DateEcheance, 
        f.clientId, c.name as clientName 
      FROM factures f 
      LEFT JOIN clients c ON f.clientId = c.id
    `;
    
    let result: any[];
    if (invoiceNumber) {
      query += ' WHERE f.NumerFacture = @invoiceNumber';
      result = await queryDatabase(query, [invoiceNumber]);
    } else if (clientId) {
      query += ' WHERE f.clientId = @clientId';
      result = await queryDatabase(query, [clientId]);
    } else {
      result = await queryDatabase(query);
    }
    
    updateConversationContext(query, 'SELECT', result);
    return result;
  } catch (error: any) {
    console.error('Error getting invoice info:', error);
    throw new Error(`Failed to retrieve invoice information: ${error.message}`);
  }
}

/**
 * Get region information from database
 */
export async function getRegionInfo(regionName?: string): Promise<any[]> {
  try {
    let query = 'SELECT * FROM Region';
    let result: any[];
    
    if (regionName) {
      query += ' WHERE Region_Libelle LIKE @regionName';
      result = await queryDatabase(query, [`%${regionName}%`]);
    } else {
      result = await queryDatabase(query);
    }
    
    updateConversationContext(query, 'SELECT', result);
    return result;
  } catch (error: any) {
    console.error('Error getting region info:', error);
    throw new Error(`Failed to retrieve region information: ${error.message}`);
  }
}

/**
 * Close the connection pool properly on application shutdown
 * Following Azure best practice for resource cleanup
 */
export async function closeConnectionPool(): Promise<void> {
  if (pool) {
    try {
      await pool.close();
      console.log('SQL connection pool closed');
    } catch (err) {
      console.error('Error closing SQL connection pool:', err);
    } finally {
      pool = null;
    }
  }
}

// Register cleanup handler for graceful shutdown
process.on('SIGINT', async () => {
  console.log('Application terminating, closing connections...');
  await closeConnectionPool();
  process.exit(0);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Application specific error handling
});