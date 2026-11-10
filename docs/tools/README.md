# Python Controller Specifications

Every agent in Cloudbank exposes **one** deterministic Python controller tool. Controllers own all `customer_snapshot` normalisation, exact integer-pence and basis-point math, monotonic `ui_view_state` screen updates, 2-strike unclear recovery, and silent cross-agent routing via `context.state["target_agent"]`.

## Controller Progression Across a Multi-Product Session

```mermaid
flowchart LR
    Entry(["Caller Turn"]) --> R["route_banking_intent<br/>(root_agent)"]
    R -->|"target_agent = everyday_banking_agent"| EB["assist_everyday_banking<br/>(everyday_banking_agent + wrapped search_help)"]
    R -->|"target_agent = savings_agent"| SAV["assist_savings<br/>(savings_agent)"]
    R -->|"target_agent = mortgage_agent"| MTG["assist_mortgages<br/>(mortgage_agent)"]
    EB <-->|"switch_intent + handoff_context"| SAV
    SAV <-->|"switch_intent"| MTG
    EB <-->|"switch_intent"| MTG
```

## Controller Specification Index

| Controller Tool | Owning Agent | Specification | Implementation Source |
| :--- | :--- | :--- | :--- |
| **`route_banking_intent`** | `root_agent` | [route_banking_intent.md](route_banking_intent.md) | [python_code.py](../../cloudbank/cxas_app/Cloudbank/tools/route_banking_intent/python_function/python_code.py#L1-L160) |
| **`assist_everyday_banking`** | `everyday_banking_agent` | [assist_everyday_banking.md](assist_everyday_banking.md) | [python_code.py](../../cloudbank/cxas_app/Cloudbank/tools/assist_everyday_banking/python_function/python_code.py#L1-L1002) |
| **`assist_savings`** | `savings_agent` | [assist_savings.md](assist_savings.md) | [python_code.py](../../cloudbank/cxas_app/Cloudbank/tools/assist_savings/python_function/python_code.py#L1-L461) |
| **`assist_mortgages`** | `mortgage_agent` | [assist_mortgages.md](assist_mortgages.md) | [python_code.py](../../cloudbank/cxas_app/Cloudbank/tools/assist_mortgages/python_function/python_code.py#L1-L628) |

### Supporting Wrapped Grounding Tool

- **`search_help`** ([search_help.json](../../cloudbank/cxas_app/Cloudbank/tools/search_help/search_help.json), deterministic fake at [python_code.py](../../cloudbank/cxas_app/Cloudbank/tools/search_help/tool_fake_config/code_block/python_code.py#L1-L17)): Google Search tool hidden from direct LLM calls in `capture_utterance` and invoked exclusively inside [`assist_everyday_banking`](assist_everyday_banking.md) when `query_type == "cancel_subscription"`.
