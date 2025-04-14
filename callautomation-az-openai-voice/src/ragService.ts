import { 
  processNaturalLanguageQuery, 
  getProductInfo, 
  getClientInfo, 
  getInvoiceInfo, 
  getRegionInfo 
} from './dbService';

/**
 * Response format for RAG (Retrieval-Augmented Generation) queries
 */
interface RagResponse {
  context: string;  // Context information for response generation
  source: string;   // Source of the information (e.g., database table name)
}

/**
 * Process a natural language query using Azure SQL and Azure OpenAI integration
 * 
 * @param query - User's natural language query
 * @returns Promise<RagResponse> with context and source
 */
export async function processQuery(query: string): Promise<RagResponse> {
  try {
    console.log(`Processing query: "${query}"`);
    
    // First try AI-powered natural language processing
    try {
      // Use the new AI-powered natural language to SQL function
      const nlResult = await processNaturalLanguageQuery(query);
      console.log(`NL query successful, source: ${nlResult.source}`);
      return nlResult;
    } catch (nlError) {
      console.warn(`NL query processing failed: ${nlError.message}`);
      console.log("Falling back to pattern matching approach...");
      
      // Fall back to the existing pattern matching approach if NL processing fails
      return await processQueryWithPatternMatching(query);
    }
  } catch (error) {
    console.error("Error in processQuery:", error);
    return {
      context: "I encountered an issue while searching for information. Please try rephrasing your question.",
      source: "error"
    };
  }
}

/**
 * Legacy pattern-matching approach as fallback
 * @param query - User's query
 */
async function processQueryWithPatternMatching(query: string): Promise<RagResponse> {
  // Normalize query to lowercase for easier pattern matching
  const normalizedQuery = query.toLowerCase();
  
  // Determine query intent and retrieve relevant information
  if (normalizedQuery.includes('ciment') || normalizedQuery.includes('article') || 
      normalizedQuery.includes('produit') || normalizedQuery.includes('prix')) {
    // Extract potential product name from query
    const productNameMatch = query.match(/(?:produit|article|ciment)\s+([a-zA-Z0-9\s]+)/i);
    const productName = productNameMatch ? productNameMatch[1].trim() : undefined;
    
    const products = await getProductInfo(productName);
    return formatProductResponse(products);
  } 
  else if (normalizedQuery.includes('client') || normalizedQuery.includes('customer')) {
    // Extract potential client name from query
    const clientNameMatch = query.match(/client\s+([a-zA-Z0-9\s]+)/i);
    const clientName = clientNameMatch ? clientNameMatch[1].trim() : undefined;
    
    const clients = await getClientInfo(clientName);
    return formatClientResponse(clients);
  }
  else if (normalizedQuery.includes('facture') || normalizedQuery.includes('invoice') || 
          normalizedQuery.includes('payment')) {
    // Extract invoice number or client info
    const invoiceMatch = query.match(/facture\s+([a-zA-Z0-9-]+)/i);
    const invoiceNumber = invoiceMatch ? invoiceMatch[1].trim() : undefined;
    
    const invoices = await getInvoiceInfo(invoiceNumber);
    return formatInvoiceResponse(invoices);
  }
  else if (normalizedQuery.includes('region') || normalizedQuery.includes('zone')) {
    // Extract region name
    const regionMatch = query.match(/region\s+([a-zA-Z0-9\s]+)/i);
    const regionName = regionMatch ? regionMatch[1].trim() : undefined;
    
    const regions = await getRegionInfo(regionName);
    return formatRegionResponse(regions);
  }
  else {
    return {
      context: "No specific database information found for this query.",
      source: "none"
    };
  }
}

// Existing helper functions for formatting responses
function formatProductResponse(products: any[]): RagResponse {
  if (products.length === 0) {
    return {
      context: "Aucun produit trouvé correspondant à cette recherche.",
      source: "ArticleCiments"
    };
  }
  
  let context = `Voici les informations sur les produits ciments disponibles:\n\n`;
  products.forEach(product => {
    context += `- Produit: ${product.Designation}\n`;
    context += `  Prix: ${product.Tarif} DH\n`;
    context += `  Disponibilité: ${product.Disponibilité ? 'En stock' : 'Rupture de stock'}\n\n`;
  });
  
  return {
    context,
    source: "ArticleCiments"
  };
}

function formatClientResponse(clients: any[]): RagResponse {
  if (clients.length === 0) {
    return {
      context: "Aucun client trouvé correspondant à cette recherche.",
      source: "clients"
    };
  }
  
  let context = `Voici les informations sur les clients:\n\n`;
  clients.forEach(client => {
    context += `- Client: ${client.name}\n`;
    context += `  Email: ${client.email}\n`;
    context += `  Montant total des factures: ${client.montantfactures} DH\n`;
    context += `  Statut: ${client.IsBlocked ? 'Bloqué' : 'Actif'}\n\n`;
  });
  
  return {
    context,
    source: "clients"
  };
}

function formatInvoiceResponse(invoices: any[]): RagResponse {
  if (invoices.length === 0) {
    return {
      context: "Aucune facture trouvée correspondant à cette recherche.",
      source: "factures"
    };
  }
  
  let context = `Voici les informations sur les factures:\n\n`;
  invoices.forEach(invoice => {
    context += `- N° Facture: ${invoice.NumerFacture}\n`;
    context += `  Client: ${invoice.clientName}\n`;
    context += `  Montant: ${invoice.MontantFacture} DH\n`;
    context += `  Date de facturation: ${formatDate(invoice.DateFacturation)}\n`;
    context += `  Date d'échéance: ${formatDate(invoice.DateEcheance)}\n`;
    context += `  Délai de paiement: ${invoice.DelaiDePaiement} jours\n\n`;
  });
  
  return {
    context,
    source: "factures"
  };
}

function formatRegionResponse(regions: any[]): RagResponse {
  if (regions.length === 0) {
    return {
      context: "Aucune région trouvée correspondant à cette recherche.",
      source: "Region"
    };
  }
  
  let context = `Voici les informations sur les régions:\n\n`;
  regions.forEach(region => {
    context += `- ID: ${region.Region_Id}, Nom: ${region.Region_Libelle}\n`;
  });
  
  return {
    context,
    source: "Region"
  };
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString('fr-FR');
}