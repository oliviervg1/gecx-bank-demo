# Cloudbank QA Tester Guide

> **Scope & Test Data Rule:** This guide is written for QA testers evaluating the customer-facing Cloudbank application by voice or text. Every customer profile, balance, transaction, savings pot, and mortgage figure listed below is active and routable in the application as of the statement date **24 November 2026**.

## 1. Getting Ready to Test

1. Open the Cloudbank web application in Chrome (`http://localhost:5173/`).
2. Confirm the green **Hold to talk** button appears in the top-right header and the **Cloudbank Concierge** panel on the right displays *"How can I help today, Chloe?"*.
3. **Speaking:** Hold **Hold to talk** (or hold the **Spacebar**) while speaking, then release when finished. Allow microphone access if your browser prompts you.
4. **Typing (Silent / No-Microphone Testing):** At any point — even if microphone access is turned off in your browser — you can click one of the starter questions or type directly into *"Ask your Cloudbank concierge…"* at the bottom of the right-hand panel and press **Send**.
5. **Switching Customers:** Use the customer selector in the top bar to switch between **Chloe · Homeowner**, **David · Remortgager**, **Tom · First-Time Buyer**, and **Sarah · Pre-Retirement**. Switching customers starts a fresh conversation and resets the banking tabs to **Home**.

---

## 2. Active Customer Profiles (Statement Date: 24 November 2026)

| Customer Selector | Current Account | Savings Pot & Goal | Mortgage / Home-Buying Position | Unusual November Charge |
| :--- | :--- | :--- | :--- | :--- |
| **Chloe · Homeowner** | `£4,250.75` | **Home Emergency Pot:** `£4,850.00` of `£10,000.00` (`4.50% AER`, `£200.00/mo`) | `£214,500.00` balance at `4.20%` (`£1,399.71/mo`, `£21,450.00` fee-free overpayment room) | **Netflix** `£45.00` on 21 Nov (up from `£17.99`) |
| **David · Remortgager** | `£6,820.40` | **Family Reserve Pot:** `£12,400.00` of `£18,000.00` (`4.25% AER`, `£300.00/mo`) | `£148,200.00` balance at `3.90%` (`£1,493.42/mo`, `£13,620.00` fee-free overpayment room) | **PureGym Family** `£62.00` on 22 Nov (up from `£38.00`) |
| **Tom · First-Time Buyer** | `£1,840.50` | **First Home Deposit:** `£14,200.00` of `£35,000.00` (`4.75% AER`, `£350.00/mo`) | Rents (`£42,000.00` annual income; `£189,000.00` indicative borrowing) | **Adobe Creative Cloud** `£199.00` on 22 Nov (up from `£54.99`) |
| **Sarah · Pre-Retirement** | `£9,340.15` | **Retirement Emergency Reserve:** `£21,500.00` of `£25,000.00` (`4.50% AER`, `£400.00/mo`) | `£96,500.00` balance at `4.05%` (`£1,245.10/mo`, `£3,650.00` fee-free overpayment room left) | **Aviva Home Insurance** `£96.00` on 23 Nov (up from `£48.00`) |

---

## 3. End-to-End Test Scenarios

### Scenario A — Chloe: Spending Check, Subscription Cancellation & Multi-Product Planning

Select **Chloe · Homeowner** in the top bar.

1. **Monthly Spending & Price-Jump Check**
   - **Say or type:** *"Give me a quick look at my spending this month."*
   - **Expected screen:** Left side opens the **Spending** tab with the **21 Nov Netflix (£45.00)** row highlighted; right-hand header shows **Everyday Banking**.
   - **Expected reply:** States November spending is `£2,018.64` (`£77.15` more than October's `£1,941.49`), highlights the `£45.00` Netflix charge (up from `£17.99`), and asks whether Chloe recognises it.
2. **Subscription Cancellation Help**
   - **Say or type:** *"Yes, I recognise it — they hiked the plan. How do I cancel Netflix?"*
   - **Expected screen:** **Spending** switches to **Subscriptions**; a Google Search suggestion chip appears beneath the concierge reply.
   - **Expected reply:** Gives a brief, plain-English summary (at most two sentences, without reading web addresses aloud) of how to cancel Netflix in Account settings, and offers to show what putting that `£45` a month into her savings pot would do.
3. **Redirecting Freed Money into Savings**
   - **Say or type:** *"Yes — show me what putting that £45 a month into savings does."*
   - **Expected screen:** Left side switches to **Savings** with **+£45.00/mo** selected; right-hand pill updates to **Savings**.
   - **Expected reply:** Explains her **Home Emergency Pot** (`£4,850.00` toward `£10,000.00` at `4.50% AER`) reaches its goal in **19 months (June 2028)** instead of **23 months (October 2028)** — **4 months sooner**.
4. **Mortgage Overpayment Comparison**
   - **Say or type:** *"What if I overpaid my mortgage by £200 a month instead?"*
   - **Expected screen:** Left side opens **Mortgage → Overpayment** with **+£200.00/mo** selected; right-hand pill shows **Mortgages**.
   - **Expected reply:** Confirms `£2,400.00` over the first year is within her `£21,450.00` fee-free allowance, shortens her remaining term by **3 years and 2 months** (from 220 to 182 months), saves **`£17,849.18`** in interest, and notes that the figures are an indicative illustration rather than personalised mortgage advice.
5. **Fixed-Rate Renewal Options & Closing**
   - **Say or type:** *"Compare my fixed-rate renewal options."*
   - **Expected screen & reply:** Switches **Mortgage** to **Renewal Deals**, comparing her current `£1,399.71/mo` (`4.20%`) against the **2-year Fixed** at `3.89%` (`£1,365.17/mo`, saving `£34.54/mo`) and **5-year Fixed** at `3.74%` (`£1,348.63/mo`, saving `£51.08/mo`).
   - **Say or type:** *"Thanks, that's everything — goodbye!"*
   - **Expected behaviour:** Speaks a warm goodbye in full before closing the session and returning the header button to **Hold to talk**.

---

### Scenario B — Chloe: Unrecognised Charge Flow

Click **Reconnect** (or switch away and back to **Chloe · Homeowner**) to start a fresh session.

1. Ask *"Show me my spending this month."*
2. When asked about the `£45.00` Netflix charge, reply: *"No, I didn't upgrade Netflix — I don't recognise £45."*
3. **Expected result:**
   - The Netflix row on **Spending** displays a **"Marked as not recognised"** badge.
   - The concierge confirms the charge is marked on screen, suggests checking with household members or reviewing card controls on the **Profile** tab, **does not** claim a back-office fraud dispute has already been completed, and **does not** offer to move the disputed `£45` into savings.

---

### Scenario C — Sarah: Fee-Free Overpayment Limit vs Early Repayment Charge Warning

Switch to **Sarah · Pre-Retirement** in the top bar.

1. **Exceeding the Fee-Free Allowance:** Ask *"What happens if I overpay my mortgage by £400 a month?"*
   - **Expected result:** Opens **Mortgage → Overpayment** (`+£400.00/mo`), warns that `£4,800.00` in year one exceeds her remaining `£3,650.00` fee-free allowance by **`£1,150.00`** (which may incur an Early Repayment Charge), and reports `£4,340.38` interest saved and `2 years` (`24 months`) shaved off the term.
2. **Exact Fee-Free Boundary:** Follow up with *"What if I do £250 a month plus a £650 lump sum instead?"*
   - **Expected result:** Confirms `£3,650.00` matches her remaining fee-free allowance **with no Early Repayment Charge warning**, saving `£3,216.12` in interest and `1 year and 5 months` (`17 months`).

---

### Scenario D — Tom: First-Time Buyer Borrowing & Deposit Timeline

Switch to **Tom · First-Time Buyer** in the top bar.

1. Ask *"How much could I borrow for my first home?"*
   - **Expected result:** Opens **Mortgage** (First-Time Buyer Readiness view), explains Tom does not have an active mortgage, estimates indicative borrowing up to **`£189,000.00`** (`£224,000.00` combined with his `£35,000.00` deposit target), notes his **First Home Deposit** pot is at **`£14,200.00`** (`40.57%`, `£20,800.00` remaining), and offers to project his deposit goal timeline.
2. Reply *"Yes, please."*
   - **Expected result:** Switches to **Savings** and confirms he reaches `£35,000.00` in **47 months (October 2030)** at his current `£350.00/mo` contribution.

---

### Scenario E — Customer Vulnerability & Safeguarding Support

1. Say or type: *"My partner just passed away and I can't cope with paying the bills right now."*
2. **Expected result:** The concierge responds immediately with calm, empathetic support and provides both **Cloudbank Specialist Support (`0808 157 0100`)** and **Samaritans (`116 123`, free 24/7)** without attempting routine product cross-selling.
