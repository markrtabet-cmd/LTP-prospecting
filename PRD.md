# PRD: La Tua Pasta London Restaurant Prospecting Tool

## 1. Product summary

La Tua Pasta needs a web-based sales prospecting tool that finds restaurants in London that may be good trade customers, scores them by suitability, tracks new openings every week, and prepares or sends sales outreach emails automatically.

The tool should begin with the total population of London restaurant and food-service businesses, then filter that population down into high-quality prospects based on cuisine, location, business type, price point, menu fit, contact availability, hygiene/status signals, and whether they already appear to be an LTP customer.

Recommended product type: internal web app.

Reason: the main users will be LTP sales/admin staff reviewing leads, filtering lists, checking contact details, editing emails, and tracking outreach. A web dashboard is clearer than a mobile app and easier to connect to databases, email tools and scheduled jobs.

## 2. Problem

LTP sales currently needs a better way to identify potential restaurant customers, especially new restaurants opening in London. Doing this manually is slow, inconsistent and easy to miss.

The company needs a system that can:

* show the full London restaurant market
* identify the restaurants most likely to buy LTP products
* detect new openings every week
* generate outreach emails
* track whether each restaurant has been contacted
* reduce repeated manual research

## 3. Goals

The product should:

1. Build a master database of London restaurant and food-service venues.
2. Filter and score restaurants by likelihood of being a good LTP customer.
3. Highlight newly opened or soon-to-open restaurants each week.
4. Generate personalised B2B outreach emails.
5. Allow sales staff to approve, edit, schedule or automatically send emails.
6. Track outreach status, replies, follow-ups and conversion.
7. Make the interface simple enough that non-technical staff can use it.

## 4. Non-goals

The first version should not try to:

* replace a full CRM like HubSpot or Salesforce
* guarantee every restaurant is perfectly classified
* scrape private or restricted data
* send emails without compliance safeguards
* rely only on AI without human review
* expand beyond London until the London workflow is proven

## 5. Target users

Primary users:

* LTP sales team
* LTP trade account managers
* LTP admin/operations staff

Secondary users:

* management team reviewing pipeline and growth
* marketing team reviewing outreach messaging

## 6. Core concept

The app should work like a sales intelligence dashboard.

At the top level, the system starts with:

Total London restaurant / food-service population

Then filters down to:

Relevant food-service venues

Then:

Potential LTP-fit venues

Then:

High-priority leads

Then:

New openings this week

Then:

Contacted / not contacted / replied / converted

Example funnel:

Total London food-service venues
→ remove supermarkets, schools, canteens, non-restaurant businesses
→ keep restaurants, hotels, caterers, gastro-pubs, delis, food halls
→ filter for menu/cuisine/price/location fit
→ score by likelihood of needing premium fresh pasta
→ identify contact details
→ generate outreach
→ track progress

## 7. Data sources

The system should use a mix of official, public and commercial data sources.

Recommended sources:

1. Food Standards Agency API
   Used for registered food businesses, local authority data, business names, addresses, hygiene ratings and coordinates.

2. ONS / Nomis business counts
   Used to benchmark the total restaurant population by geography and industry category.

3. Google Places API
   Used for live restaurant status, opening hours, reviews, website URLs, phone numbers and business categories.

4. Restaurant websites
   Used to identify menu items, cuisine type, email addresses, booking links and whether fresh pasta is relevant.

5. New-opening sources
   Examples: Hot Dinners, Eater London, SquareMeal, CODE Hospitality, Time Out London, The Infatuation London, local press, Instagram, Google Maps new listings.

6. Companies House
   Used to identify newly incorporated hospitality businesses, but this should not be treated as proof that a restaurant has opened.

7. CRM / internal customer list
   Used to exclude existing LTP customers and avoid duplicate outreach.

## 8. Lead fit criteria

The system should score restaurants based on how likely they are to become LTP customers.

Strong-fit signals:

* Italian restaurant
* Mediterranean restaurant
* premium casual dining
* fresh pasta on the menu
* ravioli, tortelloni, gnocchi, pappardelle, lasagne, filled pasta or handmade pasta mentioned
* hotel restaurant
* gastro-pub with premium food menu
* caterer or events business
* deli / food hall / farm shop
* independent or small group operator
* located within London delivery area
* has a trade-style contact email
* recently opened or opening soon
* menu changes seasonally
* has a good hygiene rating
* has mid-to-high price point

Weak-fit or exclude signals:

* fast-food only
* very low-cost takeaway
* chains with centralised procurement
* restaurants that only sell burgers, sushi, fried chicken, kebabs etc.
* supermarkets unless specifically relevant
* schools or public institutions unless LTP wants education catering
* venues already in the LTP customer list
* permanently closed restaurants
* businesses with no usable contact route
* venues with unsuitable hygiene/status issues

## 9. Lead scoring model

Each restaurant should receive a score from 0 to 100.

Example scoring:

Cuisine fit: 0–25
Menu fit: 0–25
Business type fit: 0–15
Location / delivery fit: 0–10
Price point fit: 0–10
New opening signal: 0–10
Contact quality: 0–5

Lead categories:

80–100: high-priority lead
60–79: good lead
40–59: possible lead
0–39: low priority / exclude

The score should be explainable. The user should be able to click a restaurant and see why it scored highly.

Example explanation:

“High score because this is a newly opened Italian restaurant in Soho with fresh pasta, ravioli and gnocchi on the menu, has a public trade email, and is within LTP’s London delivery area.”

## 10. Main pages

### A. Dashboard

The dashboard should show:

* total London food-service businesses found
* restaurants after basic filtering
* likely LTP-fit prospects
* high-priority leads
* new openings this week
* emails ready for approval
* emails sent this week
* replies received
* leads converted

It should include a funnel visual:

Total London restaurants
→ filtered relevant restaurants
→ scored prospects
→ new leads
→ contacted
→ replied
→ converted

### B. Lead database

A searchable table of all restaurants.

Columns:

* restaurant name
* borough
* address
* cuisine
* business type
* lead score
* status
* opening status
* contact email
* phone number
* website
* source
* last updated
* assigned salesperson
* outreach status

Filters:

* borough
* cuisine
* lead score
* new opening
* not contacted
* email available
* website available
* high priority
* already contacted
* likely existing LTP customer
* excluded
* hygiene rating
* business type

### C. Restaurant profile page

Each restaurant should have a detail page.

Sections:

* basic information
* address and map
* website and social links
* contact details
* cuisine classification
* menu summary
* pasta/menu relevance
* lead score and explanation
* data sources
* outreach history
* notes
* next action

Buttons:

* approve email
* edit email
* send email
* mark as existing customer
* mark as not relevant
* assign to salesperson
* create follow-up reminder

### D. New openings page

This is the most important weekly page.

It should show restaurants that are:

* newly registered
* newly added to Google Places
* newly mentioned in opening articles
* newly added to FSA data
* newly discovered from local hospitality sources
* marked as “opening soon”

Columns:

* restaurant name
* opening signal
* expected / actual opening date
* cuisine
* borough
* lead score
* evidence
* contact status
* email draft status

The user should be able to approve all high-priority leads or review each one manually.

### E. Email centre

This page manages outreach.

Sections:

* emails ready for review
* scheduled emails
* sent emails
* replies
* bounced emails
* unsubscribed contacts
* follow-up due

The system should generate personalised emails using restaurant data.

Example email structure:

Subject: Fresh pasta for [Restaurant Name]

Hi [Name / Team],

I saw that [Restaurant Name] has recently opened / has a strong Italian menu / serves fresh pasta dishes.

La Tua Pasta is a London-based pastificio supplying fresh pasta to restaurants, hotels, caterers and food-service businesses. We make fresh pasta overnight in London and can support chefs with filled pasta, gnocchi, long pasta and seasonal specials.

Would you be open to receiving a sample box or trade catalogue?

Best,
[Salesperson Name]
La Tua Pasta

The first version should require human approval before sending. Once the company trusts the scoring and compliance process, the system can allow automatic sending only for high-confidence corporate contacts.

## 11. Weekly automation

The tool should run automatically every week without someone manually running code.

Recommended setup:

* Web app hosted on Vercel, Render, AWS, Azure or Google Cloud
* Database hosted on Supabase Postgres, AWS RDS or Google Cloud SQL
* Scheduled background jobs using AWS EventBridge, GitHub Actions Cron, Render Cron Jobs, Supabase scheduled functions or Google Cloud Scheduler
* Email sending through SendGrid, Mailgun, HubSpot, Gmail API or Outlook API
* Error alerts sent to Slack or email

Simple version:

Every Monday at 7:00am:

1. Pull latest FSA data for London.
2. Pull Google Places updates for restaurant categories in London.
3. Check new-opening sources.
4. Compare against last week’s database.
5. Identify new restaurants.
6. Enrich each restaurant with website, menu, email and phone number.
7. Score each lead.
8. Generate email drafts.
9. Add all new leads to the dashboard.
10. Notify the sales team with a weekly summary.

The user does not need to run code because the scheduled job runs in the cloud.

## 12. “Always running” explanation

The system should not be a script on someone’s laptop.

It should be deployed to the cloud.

There are two parts:

1. The web app
   This is always available through a browser, like an internal dashboard.

2. The background worker
   This runs automatically on a schedule, even when nobody has the app open.

For example:

* The web app is hosted on Vercel.
* The database is hosted on Supabase.
* A scheduled job runs every Monday morning.
* The job updates the database and prepares emails.
* The sales team logs in and sees the latest leads.

This is how the tool can feel “constantly running” without anyone pressing run.

## 13. Email automation rules

The product should support three levels of automation.

Level 1: Draft only
The system writes emails but a human must approve and send them.

Level 2: Approved automation
The system sends emails only after the user approves a batch.

Level 3: Fully automatic
The system automatically sends emails to high-confidence contacts that pass compliance checks.

Recommended MVP: Level 1 or Level 2.

Reason: automatic cold emailing creates brand and compliance risk. LTP should first check that the data and targeting are accurate.

Compliance requirements:

* store source of contact data
* avoid emailing personal addresses unless lawful basis is confirmed
* prefer generic business emails such as info@, hello@, bookings@, events@ or trade@
* include unsubscribe / opt-out link
* maintain suppression list
* never email unsubscribed contacts again
* record when and why each contact was added
* allow manual deletion
* avoid misleading subject lines
* limit email volume per week
* avoid repeated emails to the same restaurant

## 14. Data model

Restaurant table:

* restaurant_id
* name
* address
* postcode
* borough
* latitude
* longitude
* website
* phone
* email
* cuisine_type
* business_type
* hygiene_rating
* opening_status
* first_seen_date
* last_seen_date
* source
* existing_customer_status
* lead_score
* lead_score_reason
* assigned_owner
* status

Contact table:

* contact_id
* restaurant_id
* name
* role
* email
* phone
* source
* is_generic_email
* consent_or_lawful_basis_status
* opted_out
* last_contacted_date

Outreach table:

* outreach_id
* restaurant_id
* contact_id
* email_subject
* email_body
* status
* sent_date
* opened
* replied
* bounced
* follow_up_date
* salesperson

Source evidence table:

* evidence_id
* restaurant_id
* source_name
* source_url
* evidence_type
* date_found
* summary

## 15. User permissions

Admin:

* manage users
* change scoring rules
* connect email provider
* upload existing customer list
* export data
* approve automatic sending

Sales user:

* view leads
* edit restaurant notes
* approve/send emails
* update lead status
* assign follow-ups

Viewer:

* view dashboard and reports only

## 16. MVP features

Version 1 should include:

* London-only restaurant database
* FSA data import
* Google Places enrichment
* basic website/menu scanning
* lead scoring
* dashboard
* lead table
* restaurant profile page
* new openings page
* email draft generation
* manual approval before sending
* CRM-style statuses
* weekly scheduled update
* CSV export
* suppression list for unsubscribes

## 17. Version 2 features

After MVP:

* HubSpot or Salesforce integration
* automatic sending for approved segments
* reply detection
* AI-generated personalised follow-ups
* map view of leads
* sales territory assignment
* competitor/supplier signal detection
* Instagram/new-opening monitoring
* menu-change alerts
* WhatsApp/contact-form outreach tracking
* expansion to Manchester, Birmingham, Oxford, Cambridge and other UK cities
* ROI tracking by lead source

## 18. Interface requirements

The interface must be simple and visual.

Design principles:

* show the funnel clearly
* make high-priority leads obvious
* use status badges
* let users filter quickly
* show why each lead was recommended
* keep the email approval process simple
* avoid overwhelming users with raw data

Suggested layout:

Top navigation:

Dashboard | Leads | New Openings | Emails | Reports | Settings

Dashboard cards:

* Total London venues
* Potential LTP leads
* New this week
* Emails ready
* Replies
* Converted customers

Lead table colour coding:

Green: high priority
Amber: possible lead
Grey: low priority
Red: excluded / do not contact

## 19. Success metrics

The tool is successful if it improves LTP’s sales pipeline.

Key metrics:

* number of London restaurants identified
* percentage successfully classified
* number of high-priority leads found each week
* number of new openings detected
* email approval rate
* email reply rate
* sample requests generated
* meetings booked
* new trade customers won
* revenue from tool-generated leads
* reduction in manual research time

## 20. Risks

Risk: bad data creates embarrassing outreach
Mitigation: show source evidence and require manual approval in MVP.

Risk: automatic emails damage brand
Mitigation: volume limits, review queue, opt-out handling and high-confidence sending only.

Risk: restaurant classification is inaccurate
Mitigation: explain scoring and allow users to correct classifications.

Risk: websites block scraping
Mitigation: use APIs where possible and respect robots.txt / terms.

Risk: duplicate leads
Mitigation: deduplicate by name, postcode, website and phone number.

Risk: emailing existing customers
Mitigation: upload and match against internal customer list before outreach.

## 21. Recommended build stack

Recommended stack for MVP:

Frontend: Next.js web app
Backend: Node.js / Python API
Database: Supabase Postgres
Authentication: Supabase Auth or Google Workspace login
Scheduled jobs: Supabase Scheduled Functions, GitHub Actions Cron, Render Cron or AWS EventBridge
Email: SendGrid, Mailgun, HubSpot or Gmail API
AI: OpenAI API for menu classification and email drafting
Maps: Google Maps API
Hosting: Vercel for frontend, Supabase/AWS for backend data

Best simple setup:

* Next.js on Vercel
* Supabase Postgres database
* Supabase scheduled function every Monday
* SendGrid for email drafts/sending
* Google Places API for enrichment
* FSA API for base food-business data

## 22. Example weekly workflow

Monday morning:

The background job runs automatically.

It finds:

* 340 newly updated London food businesses
* 52 likely restaurants
* 18 possible LTP-fit restaurants
* 7 high-priority leads
* 5 usable contact emails

The dashboard shows:

“7 high-priority new leads found this week.”

A sales user clicks “Review”.

They see each restaurant, why it was selected, and the draft email.

They approve 4 emails, edit 1, reject 2.

The system sends the approved emails and schedules follow-ups.

## 23. Final recommendation

Build the first version as a London-only internal web app with weekly cloud automation and human-approved email drafts.

Do not start with fully automatic email sending. Start with automatic lead discovery, automatic scoring and automatic email drafting. Then, once the data quality is proven, move to controlled automatic sending for high-confidence corporate contacts.


## Map interface

The app must include a map-based lead view so LTP can visually see where all restaurants, prospects, new openings and contacted leads are located across London.

### Purpose

The map should help users understand:

* where potential LTP customers are concentrated
* which areas have the most high-priority leads
* where new restaurants are opening
* which restaurants are already contacted
* which areas are under-covered by sales outreach
* whether a lead is inside LTP’s preferred delivery area
* whether multiple nearby restaurants can be contacted together

### Map page

Add a main navigation item:

Dashboard | Leads | Map | New Openings | Emails | Reports | Settings

The Map page should show all restaurants as pins on a London map.

Each pin should represent one restaurant or food-service venue.

Pin colours:

* Green: high-priority lead
* Amber: medium-priority lead
* Grey: low-priority lead
* Blue: existing LTP customer
* Purple: new opening this week
* Red: do not contact / excluded
* Black: permanently closed or invalid

The user should be able to click a pin and see a small restaurant preview card.

Preview card fields:

* restaurant name
* cuisine
* borough
* lead score
* opening status
* contact status
* website
* phone / email if available
* reason for recommendation
* button to open full restaurant profile
* button to approve or draft email

### Map filters

The map must include filters so users can narrow down the visible restaurants.

Filters:

* lead score
* cuisine type
* borough
* postcode area
* new openings only
* high-priority leads only
* not contacted
* contacted
* replied
* converted
* existing LTP customer
* delivery area
* email available
* website available
* hygiene rating
* business type
* last updated date

The map should update instantly when filters are applied.

### Search on map

The user should be able to search by:

* restaurant name
* postcode
* borough
* street
* cuisine
* contact status

Example searches:

* “Italian Soho”
* “new openings Hackney”
* “high score SW”
* “not contacted Shoreditch”
* “pasta Marylebone”

### Cluster view

When zoomed out, nearby restaurants should be grouped into clusters.

Example:

A cluster bubble in Soho might show “42”.

When clicked, it should zoom in and reveal the individual restaurants.

The cluster bubble should be colour-weighted if many of the leads inside are high priority.

### Heatmap mode

The map should include an optional heatmap layer.

Heatmap options:

* all restaurants
* high-priority LTP leads
* new openings
* contacted leads
* converted customers
* Italian / Mediterranean restaurants only

This helps LTP see which London areas are most attractive for sales.

### Delivery-area overlay

The map should include LTP delivery-area overlays.

Possible layers:

* current delivery area
* preferred delivery zone
* high-efficiency delivery zone
* areas outside delivery range
* future expansion zones

This allows the team to quickly see whether a lead is operationally realistic.

Example:

A restaurant with a high lead score but outside the efficient delivery zone could be marked as “good fit, lower delivery priority”.

### Route planning

Version 2 should include basic sales route planning.

The user should be able to select several restaurant pins and generate a route for in-person visits or sample drop-offs.

Route planning should show:

* selected restaurants
* best route order
* estimated travel time
* distance
* salesperson assignment
* notes for each stop

This would be useful if LTP wants to drop off samples to several restaurants in one area.

### Map and lead table connection

The map and lead table should be connected.

If a user filters the lead table, they should be able to click “View on Map”.

If a user filters the map, they should be able to click “View as List”.

This means users can switch between geographic and spreadsheet-style views without losing filters.

### Restaurant profile from map

Clicking a map pin should allow the user to open the full restaurant profile.

The profile should include:

* lead score
* scoring explanation
* source evidence
* contact details
* menu summary
* outreach history
* notes
* email draft
* status updates

### Technical implementation

Recommended map tools:

* Google Maps API
* Mapbox
* Leaflet with OpenStreetMap

Best recommendation:

Use Mapbox or Google Maps API.

Google Maps is useful because the system may already use Google Places for restaurant enrichment. Mapbox is better if LTP wants a more custom, polished dashboard style.

Each restaurant needs:

* latitude
* longitude
* full address
* postcode
* borough
* lead score
* status
* opening status
* delivery-zone status

These fields should be stored in the restaurant database so the map loads quickly.

### MVP map features

The first version should include:

* London map
* restaurant pins
* colour-coded lead status
* click-to-preview restaurant cards
* filters by borough, score, cuisine and contact status
* new openings layer
* existing customer layer
* delivery-area overlay
* link from map pin to restaurant profile

### Version 2 map features

Later versions should include:

* heatmaps
* sales route planning
* sample drop-off planning
* territory assignment
* competitor/supplier density
* area-level conversion rates
* postcode-level performance reports
* “find similar nearby leads” button

### Updated product recommendation

The product should be a web dashboard with four core views:

1. Dashboard view
   Shows the overall funnel, weekly lead numbers and sales performance.

2. Lead database view
   Shows all restaurants in a searchable and filterable table.

3. Map view
   Shows all restaurants geographically with filters, pins, clusters and delivery overlays.

4. Email centre
   Shows email drafts, approvals, sent emails, replies and follow-ups.

The Map view should be considered essential for the MVP because LTP is a physical food supplier and location strongly affects delivery, sales visits and customer targeting.
