const TEST_MODE = false;

// Helbra als Startpunkt
const TEST_LAT = 51.5576;
const TEST_LNG = 11.4924;

// Aufdeckungs-Einstellungen
const DISCOVERY_RADIUS = 60;      // Meter
const REVEAL_STEP_METERS = 20;    // Abstand zwischen Reveal-Punkten

// Karte erstellen
const map = L.map('map', {
    maxZoom: 22,
    zoomSnap: 0.5,
    zoomDelta: 0.5
}).setView([TEST_LAT, TEST_LNG], 14);

// OpenStreetMap Layer
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

let userMarker = null;
let routePoints = [];
let routeLine = null;
let lastRevealPoint = null;
let discoveredAreas = [];
let discoveredPoints = [];
let lastDrawTime = 0;
const DRAW_INTERVAL = 100; // ms (10 FPS reicht locker)


const canvas = document.getElementById("fogCanvas");
const ctx = canvas.getContext("2d");

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

resizeCanvas();
window.addEventListener("resize", resizeCanvas);

// Marker/Route aktualisieren
function updateMarkerAndRoute(lat, lng) {
    const newPoint = [lat, lng];

    if (!userMarker) {
    map.setView(newPoint, 16);
    }

    if (userMarker) {
        userMarker.setLatLng(newPoint);
    } else {
        userMarker = L.marker(newPoint).addTo(map);
    }

    routePoints.push(newPoint);

    if (routeLine) {
        routeLine.setLatLngs(routePoints);
    } else {
        routeLine = L.polyline(routePoints).addTo(map);
    }
}

// Nur zeichnen
function drawRevealCircle(lat, lng) {
    // Debug-Kreise deaktiviert
}

// Zeichnen + speichern
function addRevealCircle(lat, lng) {
    drawRevealCircle(lat, lng);
    discoveredPoints.push([lat, lng]);
    saveProgress();
}

// Zwischenpunkte setzen, damit keine Lücken entstehen
function revealPath(fromLat, fromLng, toLat, toLng) {
    const distance = map.distance([fromLat, fromLng], [toLat, toLng]);

    if (distance < 1) {
        addRevealCircle(toLat, toLng);
        return;
    }

    const steps = Math.max(1, Math.ceil(distance / REVEAL_STEP_METERS));

    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const lat = fromLat + (toLat - fromLat) * t;
        const lng = fromLng + (toLng - fromLng) * t;
        addRevealCircle(lat, lng);
    }
}

function updatePosition(lat, lng) {
    if (lastRevealPoint) {
        const dist = map.distance(lastRevealPoint, [lat, lng]);
        if (dist < 5) return; // unter 5m ignorieren
    }
    updateMarkerAndRoute(lat, lng);

    if (!lastRevealPoint) {
        addRevealCircle(lat, lng);
        lastRevealPoint = [lat, lng];
    } else {
        const [lastLat, lastLng] = lastRevealPoint;
        revealPath(lastLat, lastLng, lat, lng);
        lastRevealPoint = [lat, lng];
    }

    console.log("Position:", lat, lng);
    const now = Date.now();
    if (now - lastDrawTime > DRAW_INTERVAL) {
        drawFog();
        lastDrawTime = now;
    }
}

if (TEST_MODE) {
    const testRoute = [
        [51.5576, 11.4924],
        [51.5580, 11.4930],
        [51.5585, 11.4940],
        [51.5590, 11.4950],
        [51.5595, 11.4960]
    ];

    let i = 0;

    function playTestRoute() {
        if (i < testRoute.length) {
            const [lat, lng] = testRoute[i];
            updatePosition(lat, lng);
            i++;
            setTimeout(playTestRoute, 1000);
        }
    }

    loadProgress();
    playTestRoute();
    console.log("TEST MODE aktiv");
} else {
    if (navigator.geolocation) {
        navigator.geolocation.watchPosition(
            (position) => {
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                updatePosition(lat, lng);
            },
            (error) => {
                console.error("GPS Fehler:", error);
                alert("Standort konnte nicht abgerufen werden. Fehlercode: " + error.code);
            },
            {
                enableHighAccuracy: true,
                maximumAge: 5000,
                timeout: 15000
            }
        );
    } else {
        alert("Geolocation wird nicht unterstützt.");
    }
}

function saveProgress() {
    localStorage.setItem("fow_points", JSON.stringify(discoveredPoints));
}

function loadProgress() {
    const data = localStorage.getItem("fow_points");

    if (!data) return;

    const points = JSON.parse(data);

    for (const [lat, lng] of points) {
        drawRevealCircle(lat, lng);
    }

    discoveredPoints = points;
    drawFog();
}

function resetProgress() {
    localStorage.removeItem("fow_points");

    for (const area of discoveredAreas) {
        map.removeLayer(area);
    }

    discoveredAreas = [];
    discoveredPoints = [];
    lastRevealPoint = null;

    if (routeLine) {
        map.removeLayer(routeLine);
        routeLine = null;
    }

    routePoints = [];

    if (userMarker) {
        map.removeLayer(userMarker);
        userMarker = null;
    }

    if (TEST_MODE) {
        location.reload();
    }
}

document.getElementById("resetButton").addEventListener("click", resetProgress);

function metersToPixels(lat, lng, meters) {
    const point1 = map.latLngToContainerPoint([lat, lng]);
    const latOffset = meters / 111320;
    const point2 = map.latLngToContainerPoint([lat + latOffset, lng]);
    return Math.abs(point2.y - point1.y);
}

function drawFog() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // kompletten Nebel zeichnen
    ctx.fillStyle = "rgba(0, 0, 0, 1)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Löcher ausschneiden
    ctx.globalCompositeOperation = "destination-out";

    for (const [lat, lng] of discoveredPoints) {
        const point = map.latLngToContainerPoint([lat, lng]);
        const radiusPx = metersToPixels(lat, lng, DISCOVERY_RADIUS);
        const softRadiusPx = radiusPx * 1.35;
        const gradient = ctx.createRadialGradient(
            point.x, point.y, 0,
            point.x, point.y, softRadiusPx
        );

        gradient.addColorStop(0, "rgba(0,0,0,1)");
        gradient.addColorStop(1, "rgba(0,0,0,0)");

        ctx.fillStyle = gradient;

        ctx.beginPath();
        ctx.arc(point.x, point.y, softRadiusPx, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.globalCompositeOperation = "source-over";
}

map.on("move", drawFog);
