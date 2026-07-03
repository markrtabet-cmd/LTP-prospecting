import Anthropic from "@anthropic-ai/sdk";

// In-app assistant backend.
//
// This route is a thin, key-protecting proxy for ONE model turn. The browser
// drives the agentic loop: it sends the conversation, we call Claude with the
// tool definitions, and we return the model's content + stop_reason. When the
// model wants to act (add customers, search, navigate), the CLIENT executes the
// tool against its live data store and sends the tool_result back here for the
// next turn. That keeps tool execution where the data lives (the browser) while
// the API key never leaves the server.

export const runtime = "nodejs";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

const SYSTEM = `You are Lumen, the assistant inside "La Tua Pasta" — a London restaurant sales-prospecting tool used by LTP's sales team.

The app holds a database of ~20,000 real London restaurants (from the Food Standards Agency). Each is scored for fit on TWO factors only: cuisine and price. A venue is "recommended" when its cuisine is compatible with premium fresh pasta (Italian, Mediterranean, etc.) AND it is semi-high-class (price tier 3 = £££ or 4 = ££££). Price tiers: 1=£ budget, 2=££ mid, 3=£££ semi-premium, 4=££££ premium.

You can do almost anything in the app using tools:
- apply_filter: show the user a filtered view of the venues. Use this whenever they ask to "pull up", "show", "see", or "filter" venues (e.g. "show Italian restaurants", "pull up recommended venues in Hackney", "show our existing customers on the map"). It opens the Leads table (page:"leads") or the Map (page:"map"). Pass the cuisine/area in the user's NATURAL wording — the app automatically maps it to the closest real category, restricts the view, and reports the exact count and any substitution. Do NOT state your own counts or claim success in text; the tool's result is shown to the user.
- generate_emails: create outreach email drafts for matching venues and open the Email centre. Use when the user wants to "draft", "generate", or "write emails to" some set of venues.
- add_customers: add restaurants/customers to the database. Use when the user pastes or describes a list of existing LTP customers or venues. Set existingCustomer=true for current LTP customers. Infer cuisine and price tier when you can; otherwise omit them.
- scan_openings: scan the web for newly opened / soon-to-open London restaurants and add them. Use for "find/scan new openings".
- search_restaurants: search/filter the database to ANSWER a question in chat (returns rows + a total count). Use this to answer "how many…/which…" questions; use apply_filter instead when the user wants to SEE the list in the UI.
- get_stats: aggregate counts and breakdowns by borough or cuisine.
- navigate: take the user to a page (dashboard, leads, customers, map, new-openings, emails, reports, settings, add).

You also have Power BI analysis tools:
- list_datasets: list every semantic model/dataset in the connected Power BI workspace.
- get_data_model: inspect the real tables, columns, and measures for a dataset.
- run_dax_query: run a read-only DAX query against Power BI. Every query must start with EVALUATE, optionally after a DEFINE block. Cap row-listing queries with TOPN so the app stays responsive.
- display_result: render a result from run_dax_query as a table or chart in the chat.

Use the website/app tools for prospecting workflow requests: filtering leads, opening the map, adding customers, generating outreach emails, scanning openings, or navigating.
Use the Power BI tools for business-data questions: sales, revenue, order history, customer buying behaviour, product performance, declining/lapsed accounts, period comparisons, charts, tables, or anything the user explicitly says should come from Power BI.

For Power BI questions, if you do not know which dataset contains the answer, call list_datasets first, choose the best matching dataset, then call get_data_model. Never guess table/column/measure names when the model can be inspected. After run_dax_query, call display_result whenever the user asks to show, graph, chart, table, list, compare, or otherwise inspect data. Use a chart when it helps; use a table for rows/records.

"Areas": you know London geography — convert any neighbourhood the user names to its BOROUGH and pass it in apply_filter's borough field (Soho/Mayfair/Marylebone/Fitzrovia/Covent Garden → Westminster; Shoreditch/Dalston/Hackney → Hackney; Borough/Bermondsey/Peckham → Southwark; Clapham/Battersea → Wandsworth; Notting Hill/Chelsea/Kensington → Kensington and Chelsea; Angel → Islington; etc.). For postcode districts (SW1, E1) pass them as text. Don't make the user use exact borough names — do the mapping yourself.

Cuisine fit note: fit is ranked by closeness to Italian. Italian/Modern European/French/British/Mediterranean(mix)/gastro-pub are reasonable fits; Lebanese/Middle-Eastern, Indian, Chinese, sushi, fast food are NOT fits.

Uploaded files: the user can attach a file (CSV / spreadsheet / text). When they do, its contents are included in their message under a line like '--- Attached file "name" ---'. Parse the relevant column(s) yourself (usually restaurant names, sometimes with address/cuisine/postcode).
- "Add all customers from this file" → read every row and call add_customers with one entry per venue (existingCustomer=true). Include any borough/address/cuisine/email columns you can read.
- "Match these to the ones we already have and leave unknown ones" (or "only match existing", "skip unknown") → call add_customers with the same list PLUS skipUnknown:true, so only venues already in our database get flagged as customers and unmatched names are left out.
- "Pull up all restaurants that match this file" → extract the venue names and call apply_filter {page:"leads", names:[...]} (or page:"map") to restrict the view to those venues.

You can apply MULTIPLE cuisines and/or MULTIPLE areas at once — pass them as arrays (cuisines / boroughs), e.g. "Italian and French in Soho and Shoreditch" → apply_filter {page:"leads", cuisines:["Italian","French"], boroughs:["Westminster","Hackney"]}.

Examples of acting:
- "Show British restaurants in SW1" → apply_filter {page:"leads", cuisines:["British"], text:"SW1"}.
- "Show Italian and Greek in Hackney and Camden" → apply_filter {page:"leads", cuisines:["Italian","Greek"], boroughs:["Hackney","Camden"]}.
- "Pull up Italian spots in Shoreditch on the map" → apply_filter {page:"map", cuisine:"Italian", text:"Shoreditch"}.
- "Draft 7 emails for the best fits in Shoreditch" → generate_emails {text:"Shoreditch", limit:7}.
- "Clear the drafts" → clear_drafts.
- "Show our customers" → navigate {page:"customers"}.

Guidelines:
- ALWAYS call an appropriate tool when the user asks you to do, show, query, chart, filter, add, draft, navigate, or inspect something — never reply with plain text describing what you would do.
- Never narrate your process. Text written in a turn that also calls tools is NOT shown to the user, so write none — no "sure", "I'll", "let me", no announcing which dataset/tool you're using, no describing steps. Call the tools silently; the user only sees your final reply and any displayed views.
- For "show", "pull up", "see", "display", "find", "give me a list of", "filter", or "which..." about restaurants/prospects/venues in the app → call apply_filter. Only use search_restaurants for a pure number/answer in chat (e.g. "how many recommended Italian leads are in Hackney?").
- For "show", "pull up", "see", "display", "find", "give me a list of", "which...", "graph", "chart", "table", or "compare" about Power BI sales/order/customer/product data → use the Power BI tools and display_result.
- If a place/area is mentioned without a cuisine, still call apply_filter with just borough/text. If nothing matches a known cuisine name, pass it as text instead of cuisine.
- If they ask to email someone → generate_emails. Honour exact numbers (e.g. "7 emails" → limit:7).
- Never invent restaurants, counts, or scores.
- Never invent Power BI numbers; only report what query results support.
- After acting, use the shortest useful output and never recap the steps you took. For app actions, a terse confirmation is enough. When display_result has rendered the requested chart/table, the view IS the answer — reply with nothing beyond an essential caveat (e.g. truncated rows), or nothing at all. For a number/answer question, give just the answer. Only be conversational when the user clearly asks a chatbot-style question, asks for advice, or asks you to explain.`;

const tools: Anthropic.Tool[] = [
  {
    name: "add_customers",
    description:
      "Add one or more restaurants/customers to the database. Use when the user provides a list of existing La Tua Pasta customers or new venues. Each is matched to a known London venue when possible. Set skipUnknown:true when the user wants you to ONLY match against venues we already have and leave/skip any unknown ones (don't create new records for them).",
    input_schema: {
      type: "object",
      properties: {
        skipUnknown: { type: "boolean", description: "if true, only flag venues that match an existing one; leave unmatched names out instead of adding them as new records" },
        customers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              borough: { type: "string" },
              address: { type: "string" },
              postcode: { type: "string" },
              cuisineType: { type: "string", description: "e.g. Italian, Mediterranean, Modern European" },
              priceTier: { type: "integer", enum: [1, 2, 3, 4], description: "1=£ budget, 2=££, 3=£££ semi-premium, 4=££££ premium" },
              email: { type: "string" },
              phone: { type: "string" },
              website: { type: "string" },
              existingCustomer: { type: "boolean", description: "true if already an LTP customer" },
            },
            required: ["name"],
          },
        },
      },
      required: ["customers"],
    },
  },
  {
    name: "search_restaurants",
    description: "Search/filter the restaurant database. Returns up to `limit` matching venues plus the total match count.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "free-text match on name/borough/cuisine/postcode" },
        borough: { type: "string" },
        cuisine: { type: "string" },
        recommendedOnly: { type: "boolean" },
        existingCustomerOnly: { type: "boolean" },
        minScore: { type: "integer" },
        limit: { type: "integer", description: "max rows to return (default 15)" },
      },
    },
  },
  {
    name: "get_stats",
    description: "Get aggregate statistics: totals and counts (recommended, customers, contacted), optionally broken down by borough or cuisine.",
    input_schema: {
      type: "object",
      properties: { groupBy: { type: "string", enum: ["borough", "cuisine", "none"] } },
    },
  },
  {
    name: "apply_filter",
    description: "Open a filtered view of the venues in the UI (Leads table or Map). Use for any 'show/pull up/filter' request. To show the venues that match an uploaded file, pass `names` (the venue names from the file).",
    input_schema: {
      type: "object",
      properties: {
        page: { type: "string", enum: ["leads", "map"], description: "leads = table, map = geographic" },
        cuisines: { type: "array", items: { type: "string" }, description: "one OR MORE cuisines in natural words, e.g. [\"Italian\",\"French\"]. The app maps each to the closest category." },
        boroughs: { type: "array", items: { type: "string" }, description: "one OR MORE London BOROUGHS. Convert any neighbourhood to its borough yourself (Soho/Mayfair/Fitzrovia→Westminster, Shoreditch/Dalston→Hackney, Borough/Peckham→Southwark, Clapham/Battersea→Wandsworth, Notting Hill→Kensington and Chelsea, Angel→Islington). Put ALL locations here, not in text. For multiple areas pass them all, e.g. [\"Hackney\",\"Westminster\"]." },
        cuisine: { type: "string", description: "single cuisine (use cuisines for multiple)" },
        borough: { type: "string", description: "single borough (use boroughs for multiple)" },
        text: { type: "string", description: "free-text search for anything that isn't a cuisine or location" },
        recommendedOnly: { type: "boolean" },
        existingCustomerOnly: { type: "boolean" },
        names: { type: "array", items: { type: "string" }, description: "explicit list of venue names to show (e.g. extracted from an uploaded file) — restricts the view to those venues" },
      },
      required: ["page"],
    },
  },
  {
    name: "generate_emails",
    description: "Create outreach email drafts for matching venues and open the Email centre. e.g. 'draft 7 emails for Italian places in Shoreditch'.",
    input_schema: {
      type: "object",
      properties: {
        names: { type: "array", items: { type: "string" }, description: "specific venue names to draft for" },
        cuisine: { type: "string" },
        borough: { type: "string" },
        text: { type: "string", description: "free-text area filter — matches name/borough/postcode, e.g. 'SW1' or 'Shoreditch'" },
        recommendedOnly: { type: "boolean", description: "default true — draft for best-fit venues" },
        limit: { type: "integer", description: "exact number of drafts to create, e.g. 7" },
      },
    },
  },
  {
    name: "clear_drafts",
    description: "Discard all current email drafts (reset them to not-contacted).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "scan_openings",
    description: "Scan the web for newly opened / soon-to-open London restaurants and add them to New Openings. Use for 'find new openings', 'scan for new restaurants', etc.",
    input_schema: {
      type: "object",
      properties: { area: { type: "string", description: "optional area to focus on, e.g. 'Shoreditch' or 'SW1'" } },
    },
  },
  {
    name: "navigate",
    description: "Navigate the user to a page in the app.",
    input_schema: {
      type: "object",
      properties: { page: { type: "string", enum: ["dashboard", "leads", "customers", "map", "new-openings", "emails", "reports", "settings", "add"] } },
      required: ["page"],
    },
  },
  {
    name: "list_datasets",
    description:
      "List every Power BI semantic model/dataset in the connected workspace. Use first when a Power BI question does not clearly name a dataset.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_data_model",
    description:
      "Inspect a Power BI dataset's real tables, columns, and measures before writing DAX. Use the dataset id or exact dataset name when possible.",
    input_schema: {
      type: "object",
      properties: {
        dataset: {
          type: "string",
          description: "Power BI dataset id (preferred) or exact dataset name. Omit only when one dataset/default is available.",
        },
      },
    },
  },
  {
    name: "run_dax_query",
    description:
      "Run a read-only DAX query against Power BI. Query must contain EVALUATE, optionally after DEFINE. Always cap row-listing queries with TOPN.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "A complete DAX query, e.g. EVALUATE TOPN(20, SUMMARIZECOLUMNS('Sales'[Region], \"Revenue\", SUM('Sales'[Revenue])), [Revenue], DESC)",
        },
        dataset: {
          type: "string",
          description: "Dataset id (preferred) or exact name. Use the same dataset inspected with get_data_model.",
        },
        purpose: { type: "string", description: "One short sentence describing what this query answers." },
      },
      required: ["query"],
    },
  },
  {
    name: "display_result",
    description:
      "Render a previously fetched Power BI result as a table or chart in the Lumen chat. Call this after run_dax_query whenever the user wants to see/graph/list/compare data.",
    input_schema: {
      type: "object",
      properties: {
        result_id: { type: "string", description: "The id returned by run_dax_query." },
        as: { type: "string", enum: ["table", "bar", "line", "pie", "area"] },
        title: { type: "string", description: "Short title for the displayed data." },
        x: { type: "string", description: "Chart category/date column. Leave blank for tables." },
        series: {
          type: "array",
          items: { type: "string" },
          description: "Numeric column(s) to plot. For pie charts, provide exactly one.",
        },
      },
      required: ["result_id", "as", "title"],
    },
  },
];

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "no_api_key" });
  }

  let body: { messages?: Anthropic.MessageParam[]; context?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const messages = body.messages ?? [];

  let system = SYSTEM;
  if (body.context) {
    system += `\n\nCURRENT CONTEXT (what the user is looking at right now):\n${body.context}\nWhen the user says "this", "here", "this page", or "these", act on the current page/view above (e.g. default apply_filter's page to the current one).`;
  }

  try {
    const client = new Anthropic();
    // Low effort + modest token cap → faster, cheaper tool-routing. Cast because
    // output_config isn't in this SDK version's typings yet.
    const params = {
      model: MODEL,
      // Generous cap: bulk tool inputs (e.g. add_customers with a long pasted
      // list) must not get truncated mid-tool-call (which breaks the loop).
      max_tokens: 8192,
      system,
      tools,
      messages,
      output_config: { effort: "low" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const response = await client.messages.create(params);
    return Response.json({ content: response.content, stop_reason: response.stop_reason });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return Response.json({ error: "api_error", message }, { status: 500 });
  }
}
