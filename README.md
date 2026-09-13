# Automated Bank Transaction Parser with Gemini API & Google Apps Script

An automated, serverless pipeline that extracts structured transaction data from banking and card notification emails, logs them chronologically into Google Sheets, and tags processed emails in Gmail.


## Architecture & Privacy

This solution runs entirely within your personal Google workspace:



Gmail (Transaction Alert)
│
▼
Google Apps Script (Trigger / Batch Processing)
│
▼
Gemini API (Structured JSON Extraction)
│
▼
Google Sheets (Chronological Record & Deduplication)


* **Zero External Servers:** Runs completely inside your own Google account using Google Apps Script, Gmail, and Google Sheets.
* **Direct LLM Calls:** Only stripped email text is sent via HTTPS directly to Google's Generative Language API endpoint. No third-party data middleware or scrapers are used.


## Key Features

* **Intelligent Transaction Parsing:**
  * **Card Spends & UPI:** Cleans raw transaction text into identifiable merchant names (e.g., Swiggy, Amazon, Uber) or UPI VPAs.
  * **Bank Transfers:** Accurately labels NEFT, IMPS, and RTGS transfers with beneficiary or remitter references (e.g., `Transfer: NEFT/...`).
  * **Credit Card Bill Payments:** Distinguishes bill settlements from normal debit transactions.
  * **Merchant Refunds & Reversals:** Identifies reversals/chargebacks with their merchant entity and guarantees they are tagged strictly as `Credit`.
* **Idempotent & Deduplicated:** Every log entry stores the unique Gmail `Message ID` in Column H. Even across timeouts or multiple trigger runs, transactions are never written twice.
* **Descending Chronological Insertion:** Automatically inserts new transactions directly under row 1 headers, keeping the most recent spends visible at the top.
* **Safe Batching:** Bundles up to 15 transactions per single LLM call to respect free-tier quotas and prevent Apps Script 6-minute execution timeouts.


## Model Selection & Free-Tier Quota

This pipeline is configured by default for **`gemini-3.1-flash-lite`**.

### Why `gemini-3.1-flash-lite`?
* **High Quota Headroom on Free Tier:** Provides an allowance of **500 Requests Per Day (RPD)** and **15 Requests Per Minute (RPM)** on Google AI Studio's free tier without requiring a billing account.
* **Preview/Standard Flash Quota Warning:** Base models like `gemini-3.6-flash` often carry an unlinked free-tier daily cap of only 20 RPD. Bundling 15 emails per call into `gemini-3.1-flash-lite` easily processes up to **7,500 emails/day** within free-tier limits.
* **Reliable JSON Output:** High accuracy when handling Indian banking terminology, VPA identifiers, and multi-bank alert templates under native structured `responseSchema` enforcement.


## Prerequisites

1. **Gmail Inbound Filter & Label:**
   * Create a dedicated Gmail label (e.g., `Banking Transaction`).
   * Set up Gmail Filters (`Settings > Filters and Blocked Addresses`) to route incoming transaction notifications into this label.
   * **Important:** Ensure your filter specifically targets transaction alerts (e.g., `subject:("debited" OR "spent" OR "credited" OR "transaction alert")`) and excludes promotional emails, loan offers, and general marketing newsletters.
2. **Google Sheet:**
   * A Google Sheet tab named `Transactions`.
3. **Google AI Studio API Key:**
   * An active API key generated from [Google AI Studio](https://aistudio.google.com/).


## Setup Instructions

### Step 1: Prepare the Google Sheet
In your Google Sheet, rename the active tab to **`Transactions`** and paste these exact headers across row 1 (`A1:H1`):

| A1 | B1 | C1 | D1 | E1 | F1 | G1 | H1 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Date** | **Bank / Issuer** | **Account / Instrument Type** | **Last 4 Digits** | **Transaction Details (Merchant)** | **Amount** | **Debit / Credit** | **Message ID** |

---

### Step 2: Install Code in Google Apps Script
1. Inside your Google Sheet, navigate to **Extensions > Apps Script**.
2. Delete any boilerplate code in `Code.gs` and paste the script code from this repository.
3. Check the configuration constants at the top of the file:
   ```javascript
   const SOURCE_LABEL = "Banking Transaction";             // Must match your Gmail label exactly
   const PROCESSED_LABEL = "Banking Transaction/Processed"; // Created automatically
   const SHEET_TAB_NAME = "Transactions";


*If your Gmail label is named differently, update `SOURCE_LABEL` accordingly.*


### Step 3: Securely Add Your Gemini API Key

To prevent committing API keys into code or version control:

1. In the Apps Script editor, click the **Project Settings** gear icon (⚙️) on the left panel.
2. Scroll to **Script Properties** and click **Edit script properties** > **Add script property**.
3. Enter:
* **Property:** `GEMINI_API_KEY`
* **Value:** `<paste_your_google_ai_studio_api_key_here>`


4. Click **Save script properties**.

---

### Step 4: Run Initial Test

1. Return to the code editor tab (`< > Editor`).
2. Select **`parseTransactionsWithAI`** from the function dropdown in the toolbar.
3. Click **Run**.
4. Grant the necessary Google Account permissions (Gmail and Sheets access) when prompted.
5. Inspect the execution log to confirm successful parsing and verify that the rows appear at the top of your Google Sheet.

---

### Step 5: Configure Scheduled Weekly Automation

Because transaction emails arrive continuously, running the script on a **weekly schedule** balances prompt batching efficiency with low quota usage.

1. Click the **Triggers** icon (alarm clock ⏰) in the left navigation sidebar.
2. Click **+ Add Trigger** (bottom right).
3. Configure the trigger:
* **Function to run:** `parseTransactionsWithAI`
* **Deployment:** `Head`
* **Event source:** `Time-driven`
* **Type of time based trigger:** `Week timer`
* **Day of week:** `Every Sunday` (or preferred day)
* **Time of day:** `11pm to midnight`
* **Failure notification settings:** `Notify me daily`


4. Click **Save**.

The script will now run automatically once a week, scan all transactions arriving over the prior 8-day rolling window, batch-parse them with Gemini, prepend them to the sheet, and mark them as processed.

```

```
