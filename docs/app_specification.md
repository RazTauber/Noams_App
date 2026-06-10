# Production Taxi Routing and Optimization System Specification

This document consolidates the functional requirements, logical architecture, and test plan for the MVP version of the taxi routing system. The main goal is to save production costs and valuable time currently spent on manual coordination.

## 1. App Purpose and Logistical Need
In the production world, coordinating transportation for shooting days is a complex task requiring hours of manual work with navigation apps. The system is designed to automate the matching process between crew members and actors arriving from similar geographical areas, factoring in predicted traffic and individual requests, in order to reduce the number of taxis and save costs.

## 2. Core Principle: Simplicity First
The golden rule guiding the system's development is absolute simplicity and preventing over-engineering. Every future feature or requirement must pass a strict filter verifying its direct necessity to the main goal. Complex mechanisms such as price calculations or independent navigation interfaces were intentionally omitted in favor of a lean, stable, and fast-to-operate product.

## 3. End-to-End User Journey
1. **Raw Material Preparation**: Gathering passenger names and addresses in a basic Excel file, including marking exceptions (such as special arrival times or a requirement for a private/special taxi).
2. **Settings and Upload**: Entering the set address and main arrival time in the app interface, and dragging the Excel file in.
3. **Quality Control and Editing**: Reviewing the data in an interactive table on the screen and making manual corrections if necessary before routing.
4. **Automatic Calculation**: Running the algorithm that combines division into time buckets, geographical filtering, and requests to the Google Maps predictive traffic engine.
5. **Human Optimization**: Examining the proposed taxi cards, viewing exact delay times for each passenger, and the ability to manually separate passengers with the click of a button that triggers a recalculation.
6. **Output Generation**: Exporting an organized Excel file by passengers and exporting a clean, formatted PDF file by taxis for the transportation company.

## 4. Algorithm Logic and Dynamic Thresholds
The algorithm is based on a Greedy Algorithm approach combining strict filters with a Dynamic Threshold model to prevent unnecessary delays in short trips, while maximizing matches in long trips:

* **The Percentage Rule**: The maximum allowed delay for a passenger is 40% of their direct travel time.
* **Minimum Grace Period**: A basic deviation of up to 10 minutes will always be allowed (for very short routes).
* **Iron Ceiling (Hard Cap)**: A delay exceeding 25 minutes for a single passenger will never be approved.
* **Occupancy Limit**: Maximum of 3 passengers in a single taxi.

### Travel Scenarios

| Travel Scenario | Direct Travel Time | Proposed Delay Addition | Algorithm Decision |
| :--- | :--- | :--- | :--- |
| Short Urban (South to North Tel Aviv) | 20 minutes | 20 minutes | **Rejected** (Exceeds percentage rule and minimum grace) |
| Long Intercity (Yavne to North Tel Aviv) | 45 minutes | 18 minutes | **Approved** (Meets the 40% limit) |

## 5. Quality Assurance Test Suite

| ID | Scenario Description | Expected Result |
| :--- | :--- | :--- |
| **T01** | Attempting to run calculation without entering the set address in settings. | Clear error popup, stopping the process, and preventing unnecessary API calls. |
| **T02** | 4 passengers from the same street with the exact same arrival time. | Automatic split into 2 taxis (3 passengers in Taxi A, 1 passenger in Taxi B). |
| **T03** | 2 passengers from the same address but different arrival times (06:00 and 08:30). | Placement in completely separate taxis according to the time buckets separation. |
| **T04** | Passenger marked as "Special Taxi" in Excel or the edit screen. | Allocation of a dedicated isolated taxi, preventing matching attempts for them. |
| **T05** | Short trip (15 min) where picking up a neighbor adds 8 minutes to the route. | Match approved based on the minimum grace period of 10 minutes delay. |
| **T06** | Short trip (15 min) where picking up a neighbor adds 15 minutes to the route. | Match rejected and separated into different taxis (absolute deviation from logical ratio). |
| **T07** | Long trip (50 min) where an additional pickup adds 18 minutes to the route. | Match approved (constitutes less than 40% of the direct travel time). |
| **T08** | Very long trip where an additional pickup adds 35 minutes to the route. | Immediate rejection due to exceeding the absolute hard cap (25 minutes). |
| **T09** | Manual click on the "Separate" button in an existing taxi card. | Moving the passenger to a single taxi and automatically running a recalculation for the rest. |
| **T10** | Fallback: Entering an incorrect or unrecognized address in the Google engine. | Isolating the passenger, marking them with a warning color (red), and continuing normal operation for the rest of the list. |
| **T11** | Fallback: General communication error or expired API key. | Displaying a system blocked message preventing unexplained page crashes. |
| **T12** | Final data export after completing manual optimization. | Downloading a structured Excel file and generating a clean print view to PDF. |
