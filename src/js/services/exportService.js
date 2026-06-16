import ExcelJS from 'exceljs';

/**
 * Export service — generates Excel and PDF outputs.
 */

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2B579A' } };
const HEADER_FONT = { bold: true, size: 11, color: { argb: 'FFFFFFFF' }, name: 'Arial' };
const DATA_FONT = { size: 11, name: 'Arial' };
const THIN_BORDER = {
    top: { style: 'thin', color: { argb: 'FFB0B0B0' } },
    left: { style: 'thin', color: { argb: 'FFB0B0B0' } },
    bottom: { style: 'thin', color: { argb: 'FFB0B0B0' } },
    right: { style: 'thin', color: { argb: 'FFB0B0B0' } },
};
const TAXI_GROUP_FILLS = [
    { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } },
    { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDF2FA' } },
];
const GROUP_BOTTOM_BORDER = {
    top: { style: 'thin', color: { argb: 'FFB0B0B0' } },
    left: { style: 'thin', color: { argb: 'FFB0B0B0' } },
    bottom: { style: 'medium', color: { argb: 'FF2B579A' } },
    right: { style: 'thin', color: { argb: 'FFB0B0B0' } },
};

/**
 * Export results as a styled Excel file sorted by taxi number.
 *
 * @param {Array} taxis - Final taxi assignments
 * @param {string} destination - Set address
 * @param {string} mainTime - Main arrival time
 */
export async function exportToExcel(taxis, destination, mainTime) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Taxi Routing', {
        views: [{ state: 'frozen', ySplit: 1 }],
    });

    worksheet.columns = [
        { header: 'Taxi Number', key: 'taxiNum', width: 13 },
        { header: 'Passenger Name', key: 'name', width: 22 },
        { header: 'Phone', key: 'phone', width: 15 },
        { header: 'Pickup Address', key: 'address', width: 30 },
        { header: 'Pickup Time', key: 'pickupTime', width: 14 },
        { header: 'Required Arrival', key: 'arrivalTime', width: 17 },
        { header: 'Special Taxi', key: 'isSpecial', width: 14 },
        { header: 'Destination', key: 'destination', width: 30 },
    ];

    const dataRows = [];
    for (const taxi of taxis) {
        for (const passenger of taxi.passengers) {
            dataRows.push({
                taxiNum: taxi.number,
                name: passenger.name,
                phone: passenger.phone || '',
                address: passenger.address,
                pickupTime: passenger.pickupTime || '—',
                arrivalTime: passenger.arrivalTime || mainTime,
                isSpecial: taxi.isSpecial ? 'Yes' : 'No',
                destination,
            });
        }
    }
    dataRows.sort((a, b) => a.taxiNum - b.taxiNum);
    worksheet.addRows(dataRows);

    const headerRow = worksheet.getRow(1);
    headerRow.height = 26;
    headerRow.eachCell((cell) => {
        cell.fill = HEADER_FILL;
        cell.font = HEADER_FONT;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = THIN_BORDER;
    });

    let groupIndex = 0;
    let prevTaxi = null;
    for (let r = 2; r <= worksheet.rowCount; r++) {
        const row = worksheet.getRow(r);
        const curTaxi = row.getCell(1).value;
        if (prevTaxi !== null && curTaxi !== prevTaxi) groupIndex++;
        prevTaxi = curTaxi;

        const isLastInGroup = r === worksheet.rowCount ||
            worksheet.getRow(r + 1).getCell(1).value !== curTaxi;

        row.height = 22;
        row.eachCell({ includeEmpty: true }, (cell) => {
            cell.font = DATA_FONT;
            cell.alignment = { horizontal: 'left', vertical: 'middle' };
            cell.fill = TAXI_GROUP_FILLS[groupIndex % 2];
            cell.border = isLastInGroup ? GROUP_BOTTOM_BORDER : THIN_BORDER;
        });
    }

    const buffer = await workbook.xlsx.writeBuffer();

    const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const today = new Date().toISOString().slice(0, 10);
    link.download = `taxi_routes_${today}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
}

/**
 * Generate a printable PDF view (opens browser print dialog).
 * Creates a clean "work ticket" per taxi for the transportation company.
 *
 * @param {Array} taxis - Final taxi assignments
 * @param {string} destination - Set address
 * @param {string} mainTime - Main arrival time
 */
export function exportToPdf(taxis, destination, mainTime) {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
        alert('Please allow pop-ups to print');
        return;
    }

    const ticketsHtml = taxis.map((taxi, taxiIdx) => {
        const passengersHtml = taxi.passengers.map((p, idx) => `
            <tr class="${idx % 2 === 0 ? 'row-even' : 'row-odd'}">
                <td class="col-num">${idx + 1}</td>
                <td class="col-name">${p.name}</td>
                <td class="col-phone">${p.phone || ''}</td>
                <td class="col-address">${p.address}</td>
                <td class="col-time">${p.pickupTime || '—'}</td>
                <td class="col-time">${p.arrivalTime || mainTime}</td>
            </tr>
        `).join('');

        const statusLabel = taxi.isSpecial ? ' <span class="badge badge-special">Special</span>' : taxi.hasError ? ' <span class="badge badge-error">Error</span>' : '';

        return `
            <div class="ticket">
                <div class="ticket-accent"></div>
                <div class="ticket-content">
                    <div class="ticket-header">
                        <div class="ticket-title">
                            <span class="taxi-icon">🚖</span>
                            <h2>Taxi #${taxi.number}${statusLabel}</h2>
                        </div>
                        <div class="ticket-meta">
                            <span class="passenger-count">${taxi.passengers.length} passengers</span>
                        </div>
                    </div>
                    <table>
                        <thead>
                            <tr>
                                <th class="col-num">#</th>
                                <th class="col-name">Name</th>
                                <th class="col-phone">Phone</th>
                                <th class="col-address">Pickup Address</th>
                                <th class="col-time">Pickup Time</th>
                                <th class="col-time">Arrival at Dest.</th>
                            </tr>
                        </thead>
                        <tbody>${passengersHtml}</tbody>
                    </table>
                    <div class="destination">
                        <span class="dest-icon">📍</span>
                        <span><strong>Final Destination:</strong> ${destination}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    const today = new Date().toLocaleDateString('en-US');
    const totalPassengers = taxis.reduce((sum, t) => sum + t.passengers.length, 0);

    printWindow.document.write(`
        <!DOCTYPE html>
        <html lang="en" dir="ltr">
        <head>
            <meta charset="UTF-8">
            <title>Work Tickets - Taxis ${today}</title>
            <style>
                * { box-sizing: border-box; }
                html {
                    -webkit-print-color-adjust: exact !important;
                    print-color-adjust: exact !important;
                    color-adjust: exact !important;
                }
                body {
                    font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
                    margin: 0;
                    padding: 0;
                    direction: ltr;
                    background: #f8fafc;
                    color: #1e293b;
                    line-height: 1.5;
                }
                .page-wrapper {
                    max-width: 900px;
                    margin: 0 auto;
                    padding: 40px 30px;
                }
                .header {
                    background: linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%);
                    color: white;
                    padding: 36px 40px;
                    border-radius: 16px;
                    margin-bottom: 32px;
                    position: relative;
                    overflow: hidden;
                }
                .header::before {
                    content: '';
                    position: absolute;
                    top: -50%;
                    left: -20%;
                    width: 60%;
                    height: 200%;
                    background: radial-gradient(ellipse, rgba(255,255,255,0.08) 0%, transparent 70%);
                    pointer-events: none;
                }
                .header h1 {
                    margin: 0 0 8px;
                    font-size: 1.75rem;
                    font-weight: 700;
                    letter-spacing: -0.02em;
                }
                .header-details {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 20px;
                    margin-top: 14px;
                    font-size: 0.95rem;
                    opacity: 0.92;
                }
                .header-detail {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                .header-detail .label {
                    opacity: 0.75;
                    font-size: 0.85rem;
                }
                .summary-bar {
                    display: flex;
                    gap: 16px;
                    margin-bottom: 28px;
                    flex-wrap: wrap;
                }
                .summary-card {
                    background: white;
                    border: 1px solid #e2e8f0;
                    border-radius: 12px;
                    padding: 14px 22px;
                    flex: 1;
                    min-width: 140px;
                    text-align: center;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
                }
                .summary-card .value {
                    font-size: 1.5rem;
                    font-weight: 700;
                    color: #2563eb;
                }
                .summary-card .label {
                    font-size: 0.8rem;
                    color: #64748b;
                    margin-top: 2px;
                }
                .ticket {
                    background: white;
                    border-radius: 14px;
                    margin-bottom: 24px;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04);
                    overflow: hidden;
                    page-break-inside: avoid;
                    border: 1px solid #e2e8f0;
                    position: relative;
                    display: flex;
                }
                .ticket-accent {
                    width: 6px;
                    background: linear-gradient(180deg, #2563eb 0%, #1e40af 100%);
                    flex-shrink: 0;
                }
                .ticket-content {
                    flex: 1;
                    padding: 20px 24px;
                }
                .ticket-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 16px;
                    padding-bottom: 12px;
                    border-bottom: 2px solid #f1f5f9;
                }
                .ticket-title {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }
                .taxi-icon {
                    font-size: 1.4rem;
                }
                .ticket-title h2 {
                    margin: 0;
                    font-size: 1.15rem;
                    font-weight: 700;
                    color: #1e293b;
                }
                .badge {
                    display: inline-block;
                    padding: 2px 10px;
                    border-radius: 20px;
                    font-size: 0.72rem;
                    font-weight: 600;
                    margin-left: 8px;
                    vertical-align: middle;
                }
                .badge-special {
                    background: #fef3c7;
                    color: #92400e;
                    border: 1px solid #fcd34d;
                }
                .badge-error {
                    background: #fee2e2;
                    color: #991b1b;
                    border: 1px solid #fca5a5;
                }
                .passenger-count {
                    background: #eff6ff;
                    color: #1d4ed8;
                    padding: 4px 14px;
                    border-radius: 20px;
                    font-size: 0.82rem;
                    font-weight: 600;
                }
                table {
                    width: 100%;
                    border-collapse: separate;
                    border-spacing: 0;
                    margin-bottom: 16px;
                    border-radius: 8px;
                    overflow: hidden;
                    border: 1px solid #e2e8f0;
                }
                th {
                    background: #f8fafc;
                    padding: 10px 12px;
                    text-align: left;
                    font-size: 0.82rem;
                    font-weight: 600;
                    color: #475569;
                    text-transform: uppercase;
                    letter-spacing: 0.02em;
                    border-bottom: 2px solid #e2e8f0;
                }
                td {
                    padding: 10px 12px;
                    text-align: left;
                    font-size: 0.88rem;
                    color: #334155;
                    border-bottom: 1px solid #f1f5f9;
                }
                tr:last-child td { border-bottom: none; }
                .row-even { background: #ffffff; }
                .row-odd { background: #f8fafc; }
                .col-num { width: 40px; text-align: center; font-weight: 600; color: #94a3b8; }
                .col-name { font-weight: 500; }
                .col-phone { width: 100px; font-variant-numeric: tabular-nums; color: #475569; }
                .col-time { width: 90px; text-align: center; font-variant-numeric: tabular-nums; }
                .col-address { color: #475569; }
                .destination {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    background: linear-gradient(135deg, #eff6ff 0%, #e0f2fe 100%);
                    padding: 12px 16px;
                    border-radius: 8px;
                    font-size: 0.9rem;
                    border: 1px solid #bfdbfe;
                }
                .dest-icon { font-size: 1.1rem; }
                .footer {
                    margin-top: 40px;
                    padding-top: 20px;
                    border-top: 1px solid #e2e8f0;
                    text-align: center;
                    color: #94a3b8;
                    font-size: 0.78rem;
                }
                @media print {
                    body { background: white; padding: 0; margin: 0; }
                    .page-wrapper { padding: 10px 0; }
                    .ticket { break-inside: avoid; box-shadow: none; }
                    .header { border-radius: 0; margin: 0 0 24px; padding: 24px 30px; }
                    .summary-bar { margin-bottom: 20px; }
                    .summary-card { box-shadow: none; border: 1px solid #ccc; }
                    .footer { margin-top: 24px; }
                }
            </style>
        </head>
        <body>
            <div class="page-wrapper">
                <div class="header">
                    <h1>Work Tickets — Shooting Day Transportation</h1>
                    <div class="header-details">
                        <div class="header-detail">
                            <span class="label">Date:</span>
                            <span>${today}</span>
                        </div>
                        <div class="header-detail">
                            <span class="label">Destination:</span>
                            <span>${destination}</span>
                        </div>
                        <div class="header-detail">
                            <span class="label">Main Arrival:</span>
                            <span>${mainTime}</span>
                        </div>
                    </div>
                </div>

                <div class="summary-bar">
                    <div class="summary-card">
                        <div class="value">${taxis.length}</div>
                        <div class="label">Taxis</div>
                    </div>
                    <div class="summary-card">
                        <div class="value">${totalPassengers}</div>
                        <div class="label">Passengers</div>
                    </div>
                    <div class="summary-card">
                        <div class="value">${mainTime}</div>
                        <div class="label">Arrival Time</div>
                    </div>
                </div>

                ${ticketsHtml}

                <div class="footer">
                    Auto-generated • ${today}
                </div>
            </div>
        </body>
        </html>
    `);

    printWindow.document.close();
    setTimeout(() => printWindow.print(), 500);
}
