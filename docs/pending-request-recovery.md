# Pending requests after restart

Approval tickets and deferred decisions belong to the Runtime process that created them. A process restart expires its in-memory pending requests; replaying the saved conversation does not restore their waiting futures. Historical requests remain non-actionable unless the current owner's authoritative `session.status` lists them as pending.

Studio ignores decision notifications during history replay. A live notification can open a decision, and `session.status` replaces both pending approval and pending decision state: an empty snapshot clears old attention; a populated snapshot restores requests still owned by a live Runtime. The TUI likewise suppresses interactive approval and decision callbacks during transcript replay.

A reconnect to the same living Runtime can recover pending requests through its authoritative status. This policy does not provide durable pending queues across process death, and it does not automatically repeat a previous tool attempt. Ask the resumed session to retry the intended action when needed.
