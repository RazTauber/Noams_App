import * as XLSX from 'xlsx';
import { parsePassengers } from './utils/helpers.js';
import { ALGORITHM_CONFIG } from './utils/constants.js';
import { isApiConfigured, getApiCallCount, resetApiCallCount } from './services/mapsService.js';
import { clearAllCaches } from './services/cacheService.js';
import { calculateRoutes, separatePassenger, mergeTaxis, estimateMerge, estimateSeparate, refineTaxis } from './services/routingAlgorithm.js';
import { exportToExcel, exportToPdf } from './services/exportService.js';
import { renderPassengerTable, renderTaxiCards, resetMergeSelection, showStatus, hideStatus } from './components/ui.js';

/**
 * Application state
 */
const DEFAULT_DESTINATION = 'Herzliya Studios, HaKesem 1';

const API_CALL_WARNING_THRESHOLD = 300;
const API_CALL_BLOCK_THRESHOLD = 500;

const state = {
    passengers: [],
    taxis: [],
    errors: [],
    destination: '',
    mainTime: '06:30',
    isDirty: false,
};

/**
 * Initialize the application.
 */
function init() {
    clearAllCaches();
    setupUploadZone();
    setupCalculateButton();
    setupExportButtons();
    setupTemplateDownload();

    if (!isApiConfigured()) {
        console.info(
            '%c[Dev Mode] Google Maps API key not configured. Using mock travel times.',
            'color: #FF9500; font-weight: bold;'
        );
    }
}

/**
 * Set up drag-and-drop and click file upload.
 */
function setupUploadZone() {
    const zone = document.getElementById('uploadZone');
    const input = document.getElementById('excelFile');

    zone.addEventListener('click', () => input.click());

    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('dragover');
    });

    zone.addEventListener('dragleave', () => {
        zone.classList.remove('dragover');
    });

    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
    });

    input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) handleFile(file);
    });
}

/**
 * Process the uploaded Excel file.
 */
function handleFile(file) {
    const zone = document.getElementById('uploadZone');

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const data = new Uint8Array(event.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const rawData = XLSX.utils.sheet_to_json(firstSheet);

            state.passengers = parsePassengers(rawData);
            state.isDirty = true;

            zone.classList.add('has-file');
            zone.querySelector('.upload-zone-text').innerHTML =
                `<strong>${file.name}</strong><br>${state.passengers.length} passengers loaded successfully`;

            renderPassengerTable(state.passengers, handleRemovePassenger, handleUpdatePassenger);
        } catch (err) {
            alert('Error reading the file. Please make sure it is a valid Excel file.');
            console.error(err);
        }
    };
    reader.readAsArrayBuffer(file);
}

/**
 * Handle removing a passenger from the table.
 */
function handleRemovePassenger(index) {
    state.passengers.splice(index, 1);
    state.isDirty = true;
    renderPassengerTable(state.passengers, handleRemovePassenger, handleUpdatePassenger);
}

/**
 * Handle updating a passenger field in the table.
 */
function handleUpdatePassenger(index, field, value) {
    if (state.passengers[index]) {
        state.passengers[index][field] = value;
        state.isDirty = true;
    }
}

/**
 * Set up the calculate button.
 */
function setupCalculateButton() {
    const btn = document.getElementById('calculateBtn');
    let debounceTimer = null;

    btn.addEventListener('click', () => {
        if (debounceTimer) return;
        debounceTimer = setTimeout(() => { debounceTimer = null; }, 2000);

        runCalculation(btn);
    });

    const addressInput = document.getElementById('setAddress');
    const timeInput = document.getElementById('setTime');
    addressInput?.addEventListener('change', () => { state.isDirty = true; });
    timeInput?.addEventListener('change', () => { state.isDirty = true; });
}

async function runCalculation(btn) {
    state.destination = document.getElementById('setAddress').value.trim() || DEFAULT_DESTINATION;
    state.mainTime = document.getElementById('setTime').value;

    if (!document.getElementById('setAddress').value.trim()) {
        document.getElementById('setAddress').value = DEFAULT_DESTINATION;
    }

    if (state.passengers.length === 0) {
        showStatus('statusMessage', 'No passengers in the list. Please upload an Excel file.', 'error');
        return;
    }

    if (!state.isDirty && state.taxis.length > 0) {
        showStatus('resultsStatus', 'No changes detected — showing previous results.', 'success');
        return;
    }

    if (getApiCallCount() >= API_CALL_BLOCK_THRESHOLD) {
        showStatus('statusMessage',
            'API limit reached for this session. Please reload to continue.',
            'error');
        return;
    }

    hideStatus('statusMessage');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Calculating...';

    try {
        const result = await calculateRoutes(
            state.passengers,
            state.destination,
            state.mainTime,
            (msg) => showStatus('resultsStatus', msg, 'loading')
        );

        state.taxis = result.taxis;
        state.errors = result.errors;
        state.isDirty = false;

        hideStatus('resultsStatus');
        resetMergeSelection();

        const apiCalls = getApiCallCount();
        let summary = `Calculation complete: ${state.taxis.length} taxis for ${state.passengers.length} passengers`;
        if (apiCalls >= API_CALL_WARNING_THRESHOLD) {
            summary += ` (${apiCalls} API calls used this session)`;
        }
        showStatus('resultsStatus', summary, 'success');

        renderTaxiCards(state.taxis, handleSeparatePassenger, handleMergeTaxis, handleRefine);
    } catch (err) {
        if (err.message.includes('API')) {
            showStatus('statusMessage', 'Communication error with Google Maps — cannot calculate travel times', 'error');
        } else {
            showStatus('statusMessage', `Error: ${err.message}`, 'error');
        }
        console.error(err);
    } finally {
        btn.disabled = false;
        btn.innerHTML = 'Calculate Taxi Routes';
    }
}

/**
 * Handle separating a passenger into their own taxi (deferred — no API call).
 */
function handleSeparatePassenger(taxiId, passengerId) {
    const result = estimateSeparate(state.taxis, taxiId, passengerId, state.mainTime);
    state.taxis = result.taxis;

    const hasEstimates = state.taxis.some(t => t.passengers.some(p => p.isEstimated));
    const summary = `Updated: ${state.taxis.length} taxis` + (hasEstimates ? ' (~estimated times — click Refine)' : '');
    showStatus('resultsStatus', summary, 'success');

    renderTaxiCards(state.taxis, handleSeparatePassenger, handleMergeTaxis, handleRefine);
}

/**
 * Handle merging two taxis into one (deferred — no API call).
 */
function handleMergeTaxis(taxiId1, taxiId2) {
    const taxi1 = state.taxis.find(t => t.id === taxiId1);
    const taxi2 = state.taxis.find(t => t.id === taxiId2);

    if (!taxi1 || !taxi2) return;

    const totalPassengers = taxi1.passengers.length + taxi2.passengers.length;
    if (totalPassengers > ALGORITHM_CONFIG.MAX_PASSENGERS_PER_TAXI) {
        showStatus('resultsStatus',
            `Cannot merge: ${totalPassengers} passengers exceeds the maximum (${ALGORITHM_CONFIG.MAX_PASSENGERS_PER_TAXI})`,
            'error'
        );
        resetMergeSelection();
        renderTaxiCards(state.taxis, handleSeparatePassenger, handleMergeTaxis, handleRefine);
        return;
    }

    const result = estimateMerge(state.taxis, taxiId1, taxiId2, state.mainTime);
    state.taxis = result.taxis;

    resetMergeSelection();
    const summary = `Updated: ${state.taxis.length} taxis (~estimated times — click Refine)`;
    showStatus('resultsStatus', summary, 'success');

    renderTaxiCards(state.taxis, handleSeparatePassenger, handleMergeTaxis, handleRefine);
}

/**
 * Refine all estimated taxi times by calling the API.
 */
async function handleRefine() {
    showStatus('resultsStatus', 'Refining estimated routes...', 'loading');

    try {
        state.taxis = await refineTaxis(state.taxis, state.destination, state.mainTime);
        hideStatus('resultsStatus');

        const summary = `Refined: ${state.taxis.length} taxis`;
        showStatus('resultsStatus', summary, 'success');

        renderTaxiCards(state.taxis, handleSeparatePassenger, handleMergeTaxis, handleRefine);
    } catch (err) {
        showStatus('resultsStatus', `Refine error: ${err.message}`, 'error');
    }
}

/**
 * Set up export buttons.
 */
async function autoRefineIfNeeded() {
    const hasEstimates = state.taxis.some(t => t.passengers.some(p => p.isEstimated));
    if (!hasEstimates) return;

    showStatus('resultsStatus', 'Refining estimates before export...', 'loading');
    state.taxis = await refineTaxis(state.taxis, state.destination, state.mainTime);
    hideStatus('resultsStatus');
    renderTaxiCards(state.taxis, handleSeparatePassenger, handleMergeTaxis, handleRefine);
}

function setupExportButtons() {
    document.getElementById('exportExcelBtn').addEventListener('click', async () => {
        if (state.taxis.length === 0) return;
        try {
            await autoRefineIfNeeded();
            await exportToExcel(state.taxis, state.destination, state.mainTime);
        } catch (err) {
            alert('Error creating Excel file');
            console.error(err);
        }
    });

    document.getElementById('exportPdfBtn').addEventListener('click', async () => {
        if (state.taxis.length === 0) return;
        try {
            await autoRefineIfNeeded();
            exportToPdf(state.taxis, state.destination, state.mainTime);
        } catch (err) {
            alert('Error exporting PDF');
            console.error(err);
        }
    });
}

/**
 * Set up the CSV template download button.
 */
function setupTemplateDownload() {
    document.getElementById('downloadTemplateBtn').addEventListener('click', () => {
        const BOM = '\uFEFF';
        const headers = 'Full Name,Pickup Address,Special Taxi,Exception Time';
        const exampleRows = [
            'Israel Israeli,"Dizengoff 50, Tel Aviv",No,',
            'Yael Cohen,"Herzl 10, Rishon LeZion",Yes,08:00',
        ];
        const csv = BOM + [headers, ...exampleRows].join('\r\n');

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'template_passengers.csv';
        link.click();
        URL.revokeObjectURL(url);
    });
}

document.addEventListener('DOMContentLoaded', init);
