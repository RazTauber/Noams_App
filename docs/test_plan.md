# Taxi Scheduling System - Test Plan

## Analysis of the Test Plan
This test plan is designed for a **transportation/taxi scheduling and routing system** that groups passengers based on location, time, and specific constraints, likely utilizing the Google Maps API for distance and time calculations. 

The testing scope is well-rounded and covers several critical areas of the system:
1. **Validation & UI:** Ensures the system prevents execution without mandatory configuration (e.g., destination address).
2. **Hard Rules:** Tests absolute system constraints, such as a maximum vehicle capacity (3 passengers per taxi) and strict time-based grouping (passengers must have the same arrival time).
3. **Edge Cases:** Handles manual overrides or special passenger requirements (e.g., VIP/Solo rides).
4. **Algorithm Logic (Dynamic Thresholds):** This is the core of the system. It tests the smart-matching algorithm which decides if a detour is "worth it" based on relative percentages (e.g., max 40% delay), minimum grace periods (e.g., 10 mins), and an absolute maximum delay cap (25 mins).
5. **Manual Intervention:** Verifies that the system can dynamically recalculate routes if a user manually alters a generated group.
6. **Error Handling & Fallbacks:** Ensures the system is resilient against bad user data (unrecognized addresses) and external service failures (Google API downtime).
7. **Output/Export:** Confirms the final deliverable (Excel export) contains the correct calculated data.

## Test Plan

| ID | Category | Test Scenario | Expected Result |
| :--- | :--- | :--- | :--- |
| **T01** | Validation & UI | Attempt to run the calculation without entering the "Set Address" (Destination) in the settings. | The system will stop and display a clear error message requiring a destination to be entered; no API call to Google will be made. |
| **T02** | Hard Rules | 4 passengers with the exact same arrival time and departing from the exact same street. | The system will split them into 2 taxis (one taxi of 3 passengers and one taxi of 1 passenger), adhering to the maximum occupancy limit. |
| **T03** | Hard Rules | 2 actors from the same building, but one has an arrival time of 06:00 and the other 08:30. | The system will assign them to completely separate taxis (separated into different buckets based on set time). |
| **T04** | Edge Cases (Exceptions) | Two neighboring passengers. One of them is marked for a "Special Taxi" (Solo) in the Excel sheet or edit screen. | The system will create a dedicated taxi for the solo passenger, and will look for another match for the neighbor or send them alone. |
| **T05** | Algorithm (Dynamic Threshold) | **Short trip (Approval):** A 15-minute trip. An additional pickup extends the route by 8 minutes. | The system will approve the match (it falls within the minimum grace range of a 10-minute delay). |
| **T06** | Algorithm (Dynamic Threshold) | **Short trip (Rejection):** A 15-minute trip. An additional pickup extends the route by 15 minutes. | The system will reject the match and separate them into different taxis (the time is doubled, exceeding allowed percentages and minimums). |
| **T07** | Algorithm (Dynamic Threshold) | **Long trip (Approval):** A 50-minute trip. An additional pickup extends the route by 18 minutes. | The system will approve the match (the delay constitutes less than 40% of the original travel time). |
| **T08** | Algorithm (Dynamic Threshold) | **Iron Ceiling (Rejection):** A very long trip (e.g., Haifa to Tel Aviv). An additional pickup on the way extends the route by 35 minutes. | The system will reject the match immediately (exceeds the absolute "iron ceiling" of a 25-minute maximum delay per passenger). |
| **T09** | Manual Editing | After calculation, the user clicks "Separate" on a specific passenger within a 3-person taxi group. | The passenger will receive a separate taxi ticket, and the system will automatically recalculate to check if grouping the remaining two passengers is still efficient. |
| **T10** | Fallback (Google) | A completely incorrect pickup address (gibberish) that Google does not recognize. | The API call will fail specifically for this passenger. The system will mark them in red, dispatch them in a solo taxi (as a fallback), and continue the calculation for the rest of the passengers. |
| **T11** | Fallback (Google) | The Google API key is expired, or there is no internet connection. | The system will identify the global error and display a message: *"Communication error with Google - cannot calculate times"*, instead of crashing. |
| **T12** | Export | Clicking the "Export to Excel" button after a full taxi arrangement has been generated. | An Excel file will be created containing the passenger's name, address, calculated pickup time, and their assigned taxi number. |