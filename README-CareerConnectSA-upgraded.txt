CareerConnect SA — upgraded prototype

Files
- CareerConnectSA-upgraded.html: single-file front-end website.

New functionality
- Browser-side text extraction for PDF, DOCX and TXT documents.
- OCR support for image files (PNG/JPG/WEBP) and first-page OCR fallback for scanned PDFs.
- Suggests a qualification level and field based on extracted text; users can review/change both.
- Shows an extracted text preview and asks for consent before processing.
- Adds source/search links for current South African job, learnership, internship and university-entry discovery.
- Removes fabricated sample company vacancies from candidate matching.
- No document file is uploaded by this standalone HTML; third-party parsing libraries load from CDNs.

Important limitations
- This is still a browser-only prototype. Accounts, profiles, applications and employer vacancies are stored in memory and are lost when the page is refreshed; it is not safe for production use.
- The live opportunity links open external search/official portal pages. This page does not scrape them, verify a vacancy is still open, or automatically pull live listings into the dashboard.
- Automatic CIPC company verification is not connected; the website deliberately does not pretend a registration number has been verified.
- Scanned PDFs only get first-page OCR in this prototype. OCR and qualification inference can be wrong.
- Do not upload sensitive documents to a public/shared computer. Before launch, add secure server-side authentication, database and file storage, a backend document parser, a real opportunity feed/API, expiry checks, company verification and a privacy/retention policy.

How to test
1. Open CareerConnectSA-upgraded.html in a modern browser with internet access.
2. Create a demo account and open Upload Documents.
3. Tick the consent checkbox, choose a PDF/DOCX/TXT/image, then click Find My Matches.
4. Review the suggested qualification/field, extracted preview and Live Opportunities links.
