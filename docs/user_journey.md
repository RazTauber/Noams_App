# User Journey: Production Transportation Management

## Step 1: Raw Material Preparation (Outside the App)
**Her Need:** To gather everyone who requires transportation for the next day.
**What she does:** 
She compiles the names and pickup addresses in a simple Excel file (or exports it from her production management system). If she already knows about exceptions in advance—such as crew members who must arrive earlier for the makeup department, or an actor approved for a solo taxi—she simply notes this in the relevant rows within the Excel file.

## Step 2: Setup and Upload (Inside the App)
**Her Need:** To define the shared destination and deploy the data quickly without dealing with complex settings.
**What she does:**
1. Opens the application in the browser (this works seamlessly on both mobile and desktop).
2. Enters the exact set address for that day at the top of the page (e.g., "Herzliya Studios") along with the main arrival time (e.g., "06:30").
3. Drags and drops, or uploads, the prepared Excel file into the system.

## Step 3: Quality Control and Editing (Verification Screen)
**Her Need:** To ensure the data was captured correctly and to make last-minute adjustments without returning to the original Excel file.
**What she does:** 
The system presents her with a clear table of all passengers. She reviews it visually, and if she suddenly remembers that a certain crew member requested to be picked up from an alternative address, or if she needs to change their taxi configuration, she corrects it directly within the fields on the screen.

## Step 4: Automatic Calculation (Behind the Scenes)
**Her Need:** To save hours of manual checking on Waze and attempting complex geographic matchmaking in her head.
**What she does:** 
Clicks the "Calculate Taxi Routes" button.
**What the App does:** 
The system automatically separates the "soloists" (those requiring a private ride), divides people into groups based on their required arrival times, and calls the Google Maps API to get predicted travel times for tomorrow morning (including historical traffic conditions). It then matches people to taxis (up to 3 passengers per taxi) according to the agreed-upon percentage model and dynamic minimum threshold.

## Step 5: Human Optimization (Suggestions & Separation Screen)
**Her Need:** To see the result, understand how much time is added for each passenger, and change matches that don't seem right for logistical or personal reasons.
**What she does:** 
She views "cards" of the proposed taxis on the screen. Next to each passenger in the taxi, a transparent metric is displayed showing exactly how many minutes their route was extended compared to a direct ride (e.g., "+12 min"). If she sees a combination she prefers to change, she clicks the "Separate" button next to that passenger. The system immediately moves them to a solo taxi and automatically recalculates the remaining matches in their area.

## Step 6: Output Generation (Task Completion)
**Her Need:** To transfer accurate, clear, and respectful information to the taxi company and drivers, and to keep organized records for the production.
**What she does:**
1. **Clicks "Export to Excel"** – Receives an organized file sorted by passenger (name, address, calculated pickup time, and taxi number) for the production's internal tracking and logging.
2. **Clicks "Print to PDF"** – The browser generates a clean and styled PDF file, where each taxi is represented as a clear and organized "work ticket." This includes the list of stops, the driving order, and exact pickup times. She then sends this file directly to the supplier or the taxi company.
