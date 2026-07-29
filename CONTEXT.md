# Bee-do Capture

Bee-do turns page-level change intent into a conversation that can later drive an automated code change.

## Language

**Capture**:
An immutable submission containing a requester's change description, the page they were viewing, a rendered screenshot, and bounded page diagnostics.
_Avoid_: Bundle, ticket, prompt

**Requester**:
The Slack workspace member who creates a Capture and owns its intent.
_Avoid_: User, submitter

**Project**:
The codebase identity derived from the captured page's approved origin.
_Avoid_: App, repository selector

**Delivery**:
The publication of a Capture to its Request Channel, including the root summary and rendered screenshot.
_Avoid_: Post, upload

**Request Channel**:
The public Slack channel created for one Capture, whose root message thread is the continuing conversation surface.
_Avoid_: Ticket channel, request thread
