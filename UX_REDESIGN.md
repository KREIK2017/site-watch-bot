# Site Watch Alerts — UX/UI redesign

## Chosen direction

The interface follows the selected calm overview concept: one concise message,
clear health counts, and native Telegram inline buttons. Navigation edits the
current message wherever possible; monitoring events remain separate messages.

## Audit of the previous flow

- `/start` displayed help copy instead of the user's monitoring state.
- The persistent reply keyboard exposed only three actions and could remain in
  an old language after settings changed.
- `/list` rendered every watch at once and used technical `⚙️ #id` buttons.
- Product facts, website diagnostics, and controls competed in one long card.
- Adding a URL saved it immediately; there was no type choice, progress, review,
  confirmation, or cancellation state.
- HTTP failures and anti-bot restrictions were both presented as availability
  failures. The database had no explicit user-facing monitoring state.
- Repeated anti-bot failures were suppressed by a counter, but there was no
  state transition history, recovery event, or periodic reminder policy.
- Destructive removal happened on the first button press.
- Telegram's harmless `message is not modified` response was logged as an error.

## New navigation map

```text
/start · /status
└─ Overview
   ├─ My sites
   │  ├─ Paginated list
   │  └─ Watch card
   │     ├─ Check now
   │     ├─ History
   │     ├─ Pause / resume
   │     ├─ Open URL
   │     ├─ Technical information
   │     └─ Delete confirmation
   ├─ Add
   │  ├─ Choose site / product
   │  ├─ Paste URL
   │  ├─ Validation and initial check
   │  └─ Preview and confirmation
   ├─ Notifications
   ├─ History
   ├─ Settings
   │  ├─ Language
   │  └─ Currency
   └─ Help
```

Legacy commands such as `/watch`, `/list`, `/check`, `/history`, `/pause`,
`/resume`, and `/unwatch` remain available so existing users and links do not
break.

## Monitoring states

| State | Meaning |
| --- | --- |
| `ONLINE` | Successful 2xx check |
| `DEGRADED` | Reachable through a redirect or other limited result |
| `OFFLINE` | Confirmed HTTP failure |
| `BLOCKED` | Automated access was restricted; not proof that the site is down |
| `UNKNOWN` | The check could not establish a trustworthy result |
| `PAUSED` | Checks were deliberately suspended |

Blocked and unknown checks preserve the last trustworthy title, price, stock,
seller, and successful-check time. A state transition is written to
`monitor_events`. `BLOCKED` sends one transition message and can remind again
after 24 hours; it does not alert every five minutes. Recovery is reported as a
separate event.

## Message hierarchy

1. Overview and lists contain only decision-making information.
2. A product card shows state, price, stock, seller, and check time.
3. A site card shows state and check time.
4. HTTP code, response time, page size, platform, hosting, security headers, and
   raw last error live behind **Technical information**.
5. Destructive deletion always requires confirmation.

## Data compatibility

Migrations `0013_ux_redesign.sql` and `0014_monitor_type.sql` only add columns
and tables. Existing watch IDs, URLs, labels, selectors, history, prices, stock,
seller data, chat settings, and active/paused flags are preserved.

## Remaining product work

- Per-watch price thresholds and notification toggles.
- User-configurable quiet hours and blocked-reminder interval.
- Separate pagination for the global event history when it grows beyond the
  latest ten items.
- Expiration cleanup for abandoned add-flow sessions.
- A Telegram end-to-end test against a dedicated test bot; local automated tests
  cover the pure state and parsing logic, not Telegram's rendered clients.
