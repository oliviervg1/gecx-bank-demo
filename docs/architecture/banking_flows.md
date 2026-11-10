# Retail Banking Journeys & Conversational Flows

Cloudbank covers four interconnected retail banking domains plus three immediate customer-safeguarding guardrails. Every flow synchronises the left-hand 5-tab banking screen (`Home`, `Spending`, `Savings`, `Mortgage`, `Profile`) with the spoken or written answer in the right-hand **Cloudbank Concierge** panel.

> **Diagram Colour Key:** Green = Caller Entry · Blue = Python Controller / Search Step · Yellow = Session State & Screen Sync · Purple = Silent Specialist Handoff · Orange = Session Close or Safeguarding Escalation.

## 1. Customer Profiles Covered

| Persona | Profile | Current Account | Savings Pot | Mortgage / Home Buying | Flagged November Anomaly |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Chloe** | Homeowner | `£2,840.50` | `Home Emergency Pot` (`£4,850` / `£10,000` at `4.50% AER`) | `£214,500` at `4.20%` (`220` mo, `£21,450` ERC-free left) | Netflix `£45.00` on 21 Nov (was `£17.99`) |
| **David** | Remortgager | `£4,120.80` | `Family Holiday Fund` (`£10,800` / `£18,000` at `4.75% AER`) | `£158,200` at `3.95%` (`120` mo, `£13,620` ERC-free left) | PureGym Family `£62.00` on 22 Nov (was `£38.00`) |
| **Tom** | First-Time Buyer (Rents) | `£1,650.25` | `First Home Deposit` (`£14,200` / `£35,000` at `4.65% AER`) | Renter (`£42,000` income → `£189,000` `4.5×` borrowing) | Adobe Creative Cloud `£199.00` on 22 Nov (was `£54.99`) |
| **Sarah** | Pre-Retirement | `£6,490.10` | `Retirement Bridge Pot` (`£21,500` / `£25,000` at `4.40% AER`) | `£96,500` at `3.85%` (`90` mo, `£3,650` ERC-free left) | Aviva Home Insurance `£96.00` on 23 Nov (was `£48.00`) |

---

## 2. Concierge Entry, Navigation & Non-Terminating Unclear Ladder

```mermaid
flowchart TD
    classDef entry fill:#dcfce7,stroke:#166534,color:#14532d;
    classDef ctrl fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a;
    classDef state fill:#fef9c3,stroke:#a16207,color:#713f12;
    classDef route fill:#f3e8ff,stroke:#7e22ce,color:#581c87;
    classDef close fill:#ffedd5,stroke:#c2410c,color:#7c2d12;

    Start(["Caller Speaks or Submits Text"]):::entry --> Guard{"Safety / Prompt / FCA<br/>Vulnerability Guardrail?"}
    Guard -->|"Triggered"| Safe["Immediate Safeguarding Signpost<br/>(0808 157 0100 + 116 123)"]:::close
    Guard -->|"Clear"| Root["route_banking_intent(intent, topic_hint)"]:::ctrl
    Root -->|"GREETING / NAVIGATE_HOME / NAVIGATE_PROFILE / CAPABILITIES"| Local["Update ui_view_state(Home | Profile)<br/>Reset unclear_count = 0"]:::state
    Root -->|"EVERYDAY_BANKING / SAVINGS / MORTGAGES"| Stage["Stage target_agent + router_state<br/>Silent callback handoff"]:::route
    Root -->|"UNCLEAR (Strike 1)"| S1["Set unclear_count = 1<br/>Clarify: everyday banking, savings, or mortgages?"]:::state
    Root -->|"UNCLEAR (Strike 2)"| S2["Reset unclear_count = 0, ui_view_state = Home<br/>State full capabilities & keep session open"]:::state
    Root -->|"FAREWELL"| End["Set call_complete = true<br/>Speak farewell + Part.from_end_session"]:::close
```

---

## 3. Everyday Banking, Anomaly Confirmation & Subscription Pivot

When a monthly spending overview includes an unconfirmed flagged charge (`is_anomaly: true`), the assistant highlights the transaction row on the **Spending** tab and asks whether the customer recognises it. Confirming (`yes`) or asking how to cancel invokes wrapped Google Search (`search_help`) and offers to project redirecting the freed monthly subscription cost into **Savings**. Saying `no` marks the row on screen as `"Marked as not recognised"` without claiming a backend fraud dispute has already been filed, and never treats disputed money as freed savings.

```mermaid
flowchart TD
    classDef entry fill:#dcfce7,stroke:#166534,color:#14532d;
    classDef ctrl fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a;
    classDef state fill:#fef9c3,stroke:#a16207,color:#713f12;
    classDef route fill:#f3e8ff,stroke:#7e22ce,color:#581c87;

    Ask(["Everyday Banking Request"]):::entry --> EB["assist_everyday_banking(...)"]:::ctrl
    EB -->|"balance / category / vendor / trend / subscriptions"| View["Compute exact integer-pence slice<br/>Emit Spending or Home ui_view_state"]:::state
    EB -->|"overview (this_month)"| Ov["Report November total + delta vs October<br/>Set pending_anomaly_vendor & highlight_vendor"]:::state
    Ov -->|"Caller does not recognise ('no')"| Unrec["Set anomaly_status = unrecognised<br/>Show 'Marked as not recognised' badge + card control guidance"]:::state
    Ov -->|"Caller recognises & asks to cancel"| Cancel["Call wrapped tools.search_help<br/>Set pending_redirect_offer = True"]:::ctrl
    Cancel --> Offer["2-sentence plain cancellation summary (no URLs aloud)<br/>+ Search chip + offer Savings projection"]:::state
    Offer -->|"Caller accepts ('yes' / switch_intent=SAVINGS)"| Pivot["Write handoff_context.freed_monthly_pence<br/>Stage target_agent = savings_agent"]:::route
```

---

## 4. Savings Pot & Monthly Compound Goal Projections

```mermaid
flowchart TD
    classDef entry fill:#dcfce7,stroke:#166534,color:#14532d;
    classDef ctrl fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a;
    classDef state fill:#fef9c3,stroke:#a16207,color:#713f12;
    classDef route fill:#f3e8ff,stroke:#7e22ce,color:#581c87;

    In(["Savings Request or Pivot from Everyday Banking"]):::entry --> Sav["assist_savings(query_type, extra_monthly_amount, custom_target_amount)"]:::ctrl
    Sav --> Consume["Read & clear handoff_context<br/>Default extra_monthly_pence if projection & amount omitted"]:::state
    Consume -->|"summary / interest_rate"| Sum["Report pot balance, goal target, AER,<br/>baseline completion month & 12-month interest"]:::state
    Consume -->|"projection"| Proj["Run month-by-month half_up simulation (cap 600 mo)<br/>Emit ui_view_state(page=savings, extra_monthly_pence)"]:::ctrl
    Proj --> Sync["SavingsPage selects matching calculator pill<br/>Speak new completion month & months saved"]:::state
    Sav -->|"switch_intent = MORTGAGES | EVERYDAY_BANKING"| Hop["Stage target_agent for silent handoff"]:::route
```

---

## 5. Mortgage Overpayments, Renewal Comparison & Renter Readiness

```mermaid
flowchart TD
    classDef entry fill:#dcfce7,stroke:#166534,color:#14532d;
    classDef ctrl fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a;
    classDef state fill:#fef9c3,stroke:#a16207,color:#713f12;
    classDef route fill:#f3e8ff,stroke:#7e22ce,color:#581c87;

    In(["Mortgage or Home-Buying Request"]):::entry --> Mtg["assist_mortgages(query_type, monthly_overpayment, lump_sum_overpayment)"]:::ctrl
    Mtg --> HasMtg{"Customer has active<br/>mortgage in snapshot?"}
    HasMtg -->|"No (Tom — Renter)"| Rent["Compute 4.5x income max borrowing + First Home Deposit gap<br/>Emit ui_view_state(page=mortgage) + offer Savings pivot"]:::state
    Rent -->|"Accepts deposit projection"| ToSav["Stage target_agent = savings_agent"]:::route
    HasMtg -->|"Yes — summary / next_payment / allowance"| Summary["Emit ui_view_state(page=mortgage, subview=summary)<br/>Report balance, rate, next payment, or remaining 10% ERC-free cap"]:::state
    HasMtg -->|"Yes — overpayment_projection"| Overpay["Amortise baseline vs overpaid (min(12, months) year-1 ERC check)<br/>Emit subview=overpay + indicative illustration note"]:::state
    HasMtg -->|"Yes — rate_options"| Rates["Integer bisection for 2yr & 5yr Fixed monthly payments<br/>Emit subview=rates + deltas vs current payment"]:::state
```

---

## 6. Immediate Safeguarding & Vulnerability Guardrails

All three guardrails are configured on `app.json` (`guardrails`) with `respondImmediately` short-circuit actions so sensitive turns never reach open-ended generation:

1. **`fca_vulnerability_guardrail`:** Detects bereavement, domestic or financial abuse, severe illness, job loss, or self-harm/distress cues and responds immediately with warm UK safeguarding support — Cloudbank Specialist Support (`0808 157 0100`, an Ofcom drama-reserved Freephone range safe for demonstrations) and Samaritans (`116 123`, free 24/7).
2. **`prompt_security_guardrail`:** Blocks prompt injection, system-instruction extraction, and tool/variable override attempts.
3. **`model_safety_guardrail`:** Enforces platform safety thresholds across hate speech, dangerous content, harassment, and sexually explicit content.
