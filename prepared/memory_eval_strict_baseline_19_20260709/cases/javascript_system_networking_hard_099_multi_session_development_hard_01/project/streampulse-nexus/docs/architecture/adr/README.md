```markdown
# StreamPulse Nexus • Architectural Decision Records (ADR)

> “Architecture is about intent. An ADR is how we keep that intent from getting
> lost in the noise.” — Core Networking Guild

StreamPulse Nexus runs on hundreds of nodes, dozens of runtime modules, and an
ever-evolving feature set. Architectural Decision Records (ADRs) let us capture
_why_ a design change was made, _what_ alternatives were considered, and _who_
approved it—so future contributors can move quickly without repeating history.

---

## 1 • Repository Layout

```
streampulse-nexus/
└── docs/
    └── architecture/
        └── adr/
            ├── 0001-use-strategy-pattern-for-load-balancing.md
            ├── 0002-adopt-open-telemetry-for-metrics.md
            ├── 0003-...
            └── README.md          <-- (this file)
```

* **Sequential numbers** make ADRs easy to order.
* **Kebab-cased titles** serve as slugs.
* Once merged, ADRs are **immutable**. Amend with a “Supersedes” record.

---

## 2 • Status Vocabulary

| Status     | Meaning                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| Proposed   | Under discussion—open pull-request.                                     |
| Accepted   | Approved for implementation.                                            |
| Deprecated | Replaced by a newer ADR but still in code.                              |
| Rejected   | Considered but declined.                                                |
| Superseded | Fully replaced; implementation removed.                                 |

---

## 3 • Creating a New ADR

1. Create a feature branch:  
   `git switch -c docs/adr/<summary>`

2. Run the helper CLI (see below) or copy `templates/adr.md`.

3. Open a pull-request and tag `@core-architecture`.

4. Gain approvals, merge, and ship!

### 3.1 Automated Helper (Node.js)

The repository ships with a tiny CLI that scaffolds a new ADR, injects the next
sequence number, and opens an editor of your choice.

```bash
# From repo root
node scripts/create-adr.js "Adopt QUIC for media transport"
```

#### scripts/create-adr.js

```javascript
#!/usr/bin/env node
/**
 * StreamPulse Nexus – ADR Generator
 *
 * Usage: node scripts/create-adr.js "Concise ADR Title"
 *
 * The script:
 *   1. Scans docs/architecture/adr for the next free sequence number.
 *   2. Creates a Markdown file following the template.
 *   3. Opens the file in $EDITOR (if set).
 *
 * Dependencies: none beyond Node.js ≥ 14 (uses core modules only).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ADR_DIR   = path.join(__dirname, '..', 'docs', 'architecture', 'adr');
const TEMPLATE  = path.join(ADR_DIR, 'templates', 'adr.md');
const EDITOR    = process.env.EDITOR || null;

(async function main() {
  try {
    const title = process.argv.slice(2).join(' ').trim();
    if (!title) {
      console.error('✖  Title required.\nUsage: create-adr "Your ADR Title"');
      process.exit(1);
    }

    const nextNumber = determineNextNumber();
    const filename   = `${pad(nextNumber)}-${slugify(title)}.md`;
    const targetPath = path.join(ADR_DIR, filename);

    if (fs.existsSync(targetPath)) {
      throw new Error(`ADR already exists: ${targetPath}`);
    }

    const body = buildAdrBody(title, nextNumber);
    fs.writeFileSync(targetPath, body, { encoding: 'utf8', flag: 'wx' });

    console.log(`✓  Created ${path.relative(process.cwd(), targetPath)}`);

    if (EDITOR) {
      spawnSync(EDITOR, [targetPath], { stdio: 'inherit' });
    } else {
      console.log('ℹ  $EDITOR not set. Open the file manually to start editing.');
    }

  } catch (err) {
    console.error(`✖  ${err.message}`);
    process.exit(1);
  }
})();

/**
 * Returns the next available ADR sequence number as an integer.
 */
function determineNextNumber() {
  const files = fs.readdirSync(ADR_DIR)
                  .filter(f => /^\d{4}-.*\.md$/.test(f))
                  .map(f => parseInt(f.substring(0, 4), 10));
  return (files.length ? Math.max(...files) : 0) + 1;
}

/**
 * Pads a number with leading zeros (e.g., 7 → "0007").
 */
function pad(n) {
  return String(n).padStart(4, '0');
}

/**
 * Converts a string to kebab-case suitable for filenames.
 */
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Generates the initial ADR body using an inline template or the default one.
 */
function buildAdrBody(title, number) {
  const date = new Date().toISOString().substring(0, 10);

  // Prefer external template to allow customization
  if (fs.existsSync(TEMPLATE)) {
    const tmpl = fs.readFileSync(TEMPLATE, 'utf8');
    return tmpl
      .replace(/\$NUMBER/g, pad(number))
      .replace(/\$TITLE/g, title)
      .replace(/\$DATE/g,  date);
  }

  // Fallback inline template
  return `# ${pad(number)} • ${title}

Date: ${date}  
Status: Proposed

## Context
_Why do we need to make this decision now? What forces are at play?_

## Decision
_Concise statement of the outcome—including trade-offs._

## Consequences
_Bullet-list the positive and negative implications._

## Alternatives
_List other approaches that were considered, with pros/cons._

`;
}
```

---

## 4 • Decision Lifecycle

1. **Proposed** – PR open for discussion.  
2. **Accepted** – Merged; engineers implement.  
3. **Deprecated** – New info suggests imminent replacement.  
4. **Superseded** – A later ADR fully replaces this one.  
5. **Archived** – Removed from codebase & docs.

Versioning stays easy because ADR numbers are frozen forever; newer ADRs note
`Supersedes: 0038`.

---

## 5 • Style Guide

• Use **present tense** (“We adopt QUIC…”).  
• Keep line-length ≤ 100 for diff readability.  
• Prefix code paths with <code>\`code/\`</code> or <code>\`docs/\`</code> for clarity.  
• Link to relevant PRs, RFCs, benchmarks, or Slack threads.

---

## 6 • Inspiration & Credits

This ADR workflow borrows ideas from:

* Michael Nygard’s “Documenting Architecture Decisions”
* GitHub’s ADR conventions
* ThoughtWorks Radar’s “Lightweight Architecture Decisions”

Happy documenting, and may your decisions age gracefully ✨
```