/**
 * Automated Bank & Credit Card Transaction Parser
 * 
 * Extracts transaction data from bank notification emails using Gemini 3.1 Flash Lite
 * and logs them chronologically into Google Sheets.
 * 
 * Requirements:
 * - Google Apps Script
 * - Gemini API Key saved in Project Settings > Script Properties as 'GEMINI_API_KEY'
 */

// --- CONFIGURATION ---
const SOURCE_LABEL = "Banking Transaction";
const PROCESSED_LABEL = "Banking Transaction/Processed";
const SHEET_TAB_NAME = "Transactions";

// Execution parameters
const EMAILS_PER_CALL = 15;
const PAUSE_BETWEEN_CALLS_MS = 10000;  // Respects rate limits
const MAX_EXECUTION_TIME_MS = 270000;  // 4.5 minutes safety exit

function parseTransactionsWithAI() {
  const startTime = new Date().getTime();

  // Retrieve API Key securely from Script Properties
  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) {
    throw new Error("API Key missing. Please set 'GEMINI_API_KEY' in Project Settings > Script Properties.");
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_TAB_NAME);
  if (!sheet) throw new Error(`Sheet tab '${SHEET_TAB_NAME}' not found.`);

  // 1. Ensure 'Processed' label exists in Gmail
  let processedLabel = GmailApp.getUserLabelByName(PROCESSED_LABEL);
  if (!processedLabel) {
    processedLabel = GmailApp.createLabel(PROCESSED_LABEL);
  }

  // 2. Build deduplication set from Column H (Message ID)
  const lastRow = sheet.getLastRow();
  const existingIds = new Set();
  if (lastRow > 1) {
    const idRange = sheet.getRange(2, 8, lastRow - 1, 1).getValues();
    idRange.forEach(row => {
      if (row[0]) existingIds.add(row[0].toString().trim());
    });
  }

  // 3. Fetch recent transaction emails from the last 8 days
  const query = `label:"${SOURCE_LABEL}" newer_than:8d`;
  const threads = GmailApp.search(query, 0, 100);

  if (threads.length === 0) {
    Logger.log("No banking transaction emails found in the last 8 days.");
    return;
  }

  // 4. Filter for messages not yet present in the sheet
  const pendingMessages = [];
  for (let i = 0; i < threads.length; i++) {
    const messages = threads[i].getMessages();
    for (let j = 0; j < messages.length; j++) {
      const msg = messages[j];
      const messageId = msg.getId();

      if (!existingIds.has(messageId)) {
        const html = msg.getBody();
        const cleanBody = html
          .replace(/<style([\s\S]*?)<\/style>/gi, "")
          .replace(/<script([\s\S]*?)<\/script>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/gi, " ")
          .replace(/[\r\n\t]+/g, " ")
          .replace(/\s{2,}/g, " ")
          .substring(0, 1000);

        pendingMessages.push({
          email_id: messageId,
          subject: msg.getSubject(),
          body: cleanBody,
          received_time: msg.getDate().getTime(),
          thread: threads[i]
        });
      }
    }
  }

  if (pendingMessages.length === 0) {
    Logger.log("All transactions from the last 8 days are already logged in the Sheet.");
    return;
  }

  Logger.log(`Found ${pendingMessages.length} unrecorded transactions. Beginning processing...`);

  let totalNewAdded = 0;

  // 5. Process pending emails in structured batches
  for (let idx = 0; idx < pendingMessages.length; idx += EMAILS_PER_CALL) {
    if (new Date().getTime() - startTime > MAX_EXECUTION_TIME_MS) {
      Logger.log("Approaching execution time limit. Exiting safely.");
      break;
    }

    const batch = pendingMessages.slice(idx, idx + EMAILS_PER_CALL);
    const emailPayload = batch.map(b => ({
      email_id: b.email_id,
      subject: b.subject,
      body: b.body
    }));

    Logger.log(`Sending batch of ${batch.length} emails to Gemini...`);
    const parsedArray = callGeminiWithRetry(emailPayload, apiKey);

    if (parsedArray && Array.isArray(parsedArray)) {
      const timestampMap = new Map();
      batch.forEach(e => timestampMap.set(e.email_id, e.received_time));

      const validTransactions = [];

      parsedArray.forEach(item => {
        if (item.is_transaction && item.amount > 0 && !existingIds.has(item.email_id)) {
          validTransactions.push({
            date: item.date,
            bank: item.bank,
            instrument_type: item.instrument_type,
            last_4: item.last_4_digits ? "'" + item.last_4_digits : "N/A",
            details: item.transaction_details,
            amount: item.amount,
            direction: item.direction,
            id: item.email_id,
            timestamp: timestampMap.get(item.email_id) || 0
          });
          existingIds.add(item.email_id);
        }
      });

      // Sort descending (newest transaction first)
      validTransactions.sort((a, b) => b.timestamp - a.timestamp);

      if (validTransactions.length > 0) {
        const rowsToInsert = validTransactions.map(t => [
          t.date,
          t.bank,
          t.instrument_type,
          t.last_4,
          t.details,
          t.amount,
          t.direction,
          t.id
        ]);

        sheet.insertRowsBefore(2, rowsToInsert.length);
        sheet.getRange(2, 1, rowsToInsert.length, 8).setValues(rowsToInsert);
        totalNewAdded += rowsToInsert.length;
      }

      batch.forEach(b => b.thread.addLabel(processedLabel));
    } else {
      Logger.log("Batch failed. Will retry on next scheduled execution.");
      break;
    }

    if (idx + EMAILS_PER_CALL < pendingMessages.length) {
      Utilities.sleep(PAUSE_BETWEEN_CALLS_MS);
    }
  }

  Logger.log(`Run complete. Successfully added ${totalNewAdded} transactions to Sheet.`);
}

/**
 * Invokes Gemini 3.1 Flash Lite with JSON schema and auto-retry logic.
 */
function callGeminiWithRetry(emailBatch, apiKey, retryCount = 0) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;

  const prompt = `
You are an expert financial transaction parser for banks and card issuers.
Analyze the provided batch of emails and extract an array of structured transaction records matching each email_id.

RULES FOR EXTRACTION:
1. email_id: Must match the given ID exactly.
2. is_transaction: Set to false if it is purely an OTP, marketing promo, loan offer, or account summary without an actual spend/credit.
3. bank: Name of bank or card issuer (e.g. "HDFC Bank", "Axis Bank", "SBI Card", "State Bank of India", "HSBC", "Chase", "Citibank").
4. instrument_type: Strictly "Credit Card", "Debit Card", or "Savings Account".
5. last_4_digits: 4-digit card or account number if mentioned; otherwise null.
6. transaction_details:
   - Spends: Clean merchant name (e.g. "Flipkart", "Swiggy", "Amazon", "Uber").
   - UPI: Merchant name or VPA.
   - NEFT/IMPS/RTGS/Transfers: Label as "Transfer: [Remitter/Beneficiary/Ref]".
   - Credit Card Bill Payment: Label as "Credit Card Bill Payment".
   - Refunds/Reversals: Label as "Refund: [Merchant]".
7. amount: Numeric transaction amount.
8. direction: Strictly "Debit" or "Credit" (refunds, reversals, credits are "Credit").
9. date: YYYY-MM-DD.
`;

  const payload = {
    contents: [
      {
        parts: [
          { text: prompt },
          { text: JSON.stringify(emailBatch) }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            email_id: { type: "STRING" },
            is_transaction: { type: "BOOLEAN" },
            bank: { type: "STRING" },
            instrument_type: { 
              type: "STRING", 
              enum: ["Credit Card", "Debit Card", "Savings Account"] 
            },
            last_4_digits: { type: "STRING", nullable: true },
            transaction_details: { type: "STRING" },
            amount: { type: "NUMBER" },
            direction: { 
              type: "STRING", 
              enum: ["Debit", "Credit"] 
            },
            date: { type: "STRING" }
          },
          required: [
            "email_id",
            "is_transaction",
            "bank",
            "instrument_type",
            "transaction_details",
            "amount",
            "direction",
            "date"
          ]
        }
      }
    }
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();

    if (code === 200) {
      const data = JSON.parse(response.getContentText());
      const candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (candidateText) {
        return JSON.parse(candidateText);
      }
    } else if ((code === 503 || code === 429) && retryCount < 1) {
      Logger.log(`Encountered HTTP ${code}. Retrying in 10s...`);
      Utilities.sleep(10000);
      return callGeminiWithRetry(emailBatch, apiKey, retryCount + 1);
    } else {
      Logger.log(`Gemini API Error (HTTP ${code}): ${response.getContentText()}`);
    }
  } catch (e) {
    Logger.log("Fetch error: " + e.toString());
  }

  return null;
}