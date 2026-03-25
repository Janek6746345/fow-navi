const TEST_MODE = false;

// Helbra als Startpunkt
const TEST_LAT = 51.5576;
const TEST_LNG = 11.4924;

// Aufdeckungs-Einstellungen
const DISCOVERY_RADIUS = 60;
const MIN_POINT_DISTANCE = 10; // Meter
const POI_DISCOVERY_RADIUS = 10;

const pois = [
    {
        id: "test_poi_1",
        name: "Test-Wahrzeichen",
        lat: 51.5576,
        lng: 11.4924,
        discovered: false
    }
];

// Karte erstellen
const map = L.map('map', {
    maxZoom: 19,
    zoomSnap: 0.5,
    zoomDelta: 0.5
}).setView([0, 0], 14);

// OpenStreetMap Layer
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19
}).addTo(map);

let userMarker = null;
let routePoints = [];
let routeLine = null;
let lastRevealPoint = null;
let discoveredAreas = [];
let discoveredPoints = [];
let poiMarkers = [];
let lastPositionTime = null;
let currentSpeedKmh = 0;
let lastAcceptedPoint = null;
let smoothedPoint = null;
let hasInitialFix = false;
let isFollowingUser = true;
let playerXP = 0;
let playerLevel = 1;

let lastDrawTime = 0;

const DRAW_INTERVAL = 100; // ms
const STATIONARY_SPEED_THRESHOLD = 1.5; // km/h
const STATIONARY_DISTANCE_THRESHOLD = 8; // Meter

const speedInfoEl = document.getElementById("speedInfo");
const xpInfoEl = document.getElementById("xpInfo");
const xpFillEl = document.getElementById("xpFill");
const poiToastEl = document.getElementById("poiToast");
const recenterButtonEl = document.getElementById("recenterButton");
function updateRecenterButtonVisibility() {
    if (!recenterButtonEl) return;

    recenterButtonEl.style.display = isFollowingUser ? "none" : "block";
}
const canvas = document.getElementById("fogCanvas");
const ctx = canvas.getContext("2d");

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    drawFog();
}

resizeCanvas();
window.addEventListener("resize", resizeCanvas);
loadXP();
loadProgress();
loadPOIs();
renderPOIMarkers();
updateRecenterButtonVisibility();

function savePOIs() {
    localStorage.setItem("fow_pois", JSON.stringify(
        pois.map(poi => ({
            id: poi.id,
            discovered: poi.discovered
        }))
    ));
}

function loadPOIs() {
    const data = localStorage.getItem("fow_pois");
    if (!data) return;

    const savedPOIs = JSON.parse(data);

    for (const savedPoi of savedPOIs) {
        const poi = pois.find(p => p.id === savedPoi.id);
        if (poi) {
            poi.discovered = !!savedPoi.discovered;
        }
    }
}

function renderPOIMarkers() {
    for (const marker of poiMarkers) {
        map.removeLayer(marker);
    }

    poiMarkers = [];

    for (const poi of pois) {
        const marker = L.circleMarker([poi.lat, poi.lng], {
            radius: 8,
            color: poi.discovered ? "green" : "gold",
            fillColor: poi.discovered ? "green" : "gold",
            fillOpacity: 0.9,
            weight: 2
        });

        marker.bindPopup(poi.name);
        marker.addTo(map);
        poiMarkers.push(marker);
    }
}

function discoverPOI(poi) {
    if (poi.discovered) return;

    poi.discovered = true;
    savePOIs();
    renderPOIMarkers();
    addXP(100);

    if (poiToastEl) {
        poiToastEl.textContent = `📍 Entdeckt: ${poi.name} (+100 EXP)`;
        poiToastEl.style.opacity = "1";

        setTimeout(() => {
            poiToastEl.style.opacity = "0";
        }, 2000);
    }

    console.log("POI entdeckt:", poi.name);
}

function checkPOIs(playerLat, playerLng) {
    for (const poi of pois) {
        if (poi.discovered) continue;

        const distance = map.distance([playerLat, playerLng], [poi.lat, poi.lng]);

        if (distance <= POI_DISCOVERY_RADIUS) {
            discoverPOI(poi);
        }
    }
}

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

// Debug-Kreise deaktiviert
function drawRevealCircle(lat, lng) {
    // absichtlich leer
}

// Zeichnen + speichern
function addRevealCircle(lat, lng) {
    const newPoint = [lat, lng];

    if (discoveredPoints.length > 0) {
        const lastPoint = discoveredPoints[discoveredPoints.length - 1];
        const distance = map.distance(lastPoint, newPoint);

        if (distance < MIN_POINT_DISTANCE) {
            return; // zu nah → ignorieren
        }
    }

    drawRevealCircle(lat, lng);
    discoveredPoints.push(newPoint);
    addXP(1);
}

// Zwischenpunkte setzen, damit keine Lücken entstehen
function revealPath(fromLat, fromLng, toLat, toLng) {
    const distance = map.distance([fromLat, fromLng], [toLat, toLng]);

    if (distance < 1) {
        addRevealCircle(toLat, toLng);
        return;
    }

    const dynamicStep = getDynamicRevealStep(currentSpeedKmh);
    const steps = Math.max(1, Math.ceil(distance / dynamicStep));

    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const lat = fromLat + (toLat - fromLat) * t;
        const lng = fromLng + (toLng - fromLng) * t;
        addRevealCircle(lat, lng);
    }
}

function updateSpeedDisplay(speedKmh) {
    speedInfoEl.textContent = `Speed: ${speedKmh.toFixed(1)} km/h`;
}

function estimateSpeedKmh(lat, lng, timestampMs) {
    if (!lastRevealPoint || !lastPositionTime) return 0;

    const distanceMeters = map.distance(lastRevealPoint, [lat, lng]);
    const deltaSeconds = (timestampMs - lastPositionTime) / 1000;

    if (deltaSeconds <= 0) return 0;

    const metersPerSecond = distanceMeters / deltaSeconds;
    return metersPerSecond * 3.6;
}

function getDynamicRevealStep(speedKmh) {
    if (speedKmh < 8) return 15;       // zu Fuß
    if (speedKmh < 25) return 25;      // Joggen/Fahrrad
    if (speedKmh < 80) return 40;      // Stadt/Landstraße
    if (speedKmh < 180) return 80;     // Autobahn/Zug
    return 150;                        // sehr schnell / Flugzeug grob
}

function isOutlierJump(lat, lng, speedKmh) {
    if (!lastAcceptedPoint || !lastPositionTime) return false;

    const now = Date.now();
    const deltaSeconds = (now - lastPositionTime) / 1000;
    if (deltaSeconds <= 0) return false;

    const distanceMeters = map.distance(lastAcceptedPoint, [lat, lng]);
    const estimatedKmh = (distanceMeters / deltaSeconds) * 3.6;

    if (speedKmh < 15 && estimatedKmh > 80) return true;
    if (speedKmh < 80 && estimatedKmh > 250) return true;
    if (estimatedKmh > 1200) return true;

    return false;
}

function smoothPosition(lat, lng, speedKmh) {
    if (!smoothedPoint) {
        smoothedPoint = [lat, lng];
        return smoothedPoint;
    }

    let alpha = 0.35;

    if (speedKmh < 10) alpha = 0.25;
    else if (speedKmh < 50) alpha = 0.35;
    else if (speedKmh < 120) alpha = 0.5;
    else alpha = 0.65;

    const [oldLat, oldLng] = smoothedPoint;

    const newLat = oldLat + (lat - oldLat) * alpha;
    const newLng = oldLng + (lng - oldLng) * alpha;

    smoothedPoint = [newLat, newLng];
    return smoothedPoint;
}

function updatePosition(lat, lng, speedMps = null) {
    const now = Date.now();

    let speedKmh = 0;

    if (typeof speedMps === "number" && !Number.isNaN(speedMps) && speedMps >= 0) {
        speedKmh = speedMps * 3.6;
    } else {
        speedKmh = estimateSpeedKmh(lat, lng, now);
    }

    currentSpeedKmh = speedKmh;
    updateSpeedDisplay(currentSpeedKmh);

    if (isOutlierJump(lat, lng, currentSpeedKmh)) {
        console.log("Ausreißer ignoriert:", lat, lng, currentSpeedKmh.toFixed(1));
        return;
    }

    if (lastAcceptedPoint) {
        const driftDistance = map.distance(lastAcceptedPoint, [lat, lng]);

        if (
            currentSpeedKmh < STATIONARY_SPEED_THRESHOLD &&
            driftDistance < STATIONARY_DISTANCE_THRESHOLD
        ) {
            console.log("Stillstand/Drift ignoriert:", driftDistance.toFixed(1), "m");
            return;
        }
    }

    const [smoothLat, smoothLng] = smoothPosition(lat, lng, currentSpeedKmh);

    if (!hasInitialFix) {
        map.setView([smoothLat, smoothLng], 16);
        updateMarkerAndRoute(smoothLat, smoothLng);
        checkPOIs(smoothLat, smoothLng);
        addRevealCircle(smoothLat, smoothLng);

        hasInitialFix = true;
        lastRevealPoint = [smoothLat, smoothLng];
        lastAcceptedPoint = [lat, lng];
        lastPositionTime = now;
    } else {
        updateMarkerAndRoute(smoothLat, smoothLng);

        if (isFollowingUser) {
            map.panTo([smoothLat, smoothLng]);
        }

        checkPOIs(smoothLat, smoothLng);

        const [lastLat, lastLng] = lastRevealPoint;
        revealPath(lastLat, lastLng, smoothLat, smoothLng);
        lastRevealPoint = [smoothLat, smoothLng];
        lastAcceptedPoint = [lat, lng];
        lastPositionTime = now;
    }

    const nowDraw = Date.now();
    if (nowDraw - lastDrawTime > DRAW_INTERVAL) {
        drawFog();
        lastDrawTime = nowDraw;
    }

    saveProgress();

    console.log("Position:", lat, lng, "Speed km/h:", currentSpeedKmh.toFixed(1));
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
            updatePosition(lat, lng, 5);
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
                const speed = position.coords.speed;
                updatePosition(lat, lng, speed);
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

function getXPRequiredForLevel(level) {
    if (level <= 1) return 0;

    let required = 100;

    for (let l = 2; l < level; l++) {
        required = Math.floor(required * 1.5);
    }

    return required;
}

function getLevelFromXP(xp) {
    let level = 1;

    while (xp >= getXPRequiredForLevel(level + 1)) {
        level++;
    }

    return level;
}

function getLevelThresholds(level) {
    return {
        current: getXPRequiredForLevel(level),
        next: getXPRequiredForLevel(level + 1)
    };
}

function updateXPDisplay() {
    playerLevel = getLevelFromXP(playerXP);

    const { current, next } = getLevelThresholds(playerLevel);
    const levelXP = playerXP - current;
    const neededXP = next - current;
    const percent = Math.max(0, Math.min(100, (levelXP / neededXP) * 100));

    xpInfoEl.textContent = `Level ${playerLevel} • ${playerXP} EXP`;
    xpFillEl.style.width = `${percent}%`;
}

function addXP(amount) {
    playerXP += amount;
    updateXPDisplay();
    saveXP();
}

function saveXP() {
    localStorage.setItem("fow_xp", JSON.stringify({
        xp: playerXP
    }));
}

function loadXP() {
    const data = localStorage.getItem("fow_xp");

    if (!data) {
        updateXPDisplay();
        return;
    }

    const parsed = JSON.parse(data);
    playerXP = parsed.xp || 0;
    updateXPDisplay();
}

function saveProgress() {
    localStorage.setItem("fow_points", JSON.stringify(discoveredPoints));
    console.log("Gespeicherte Fog-Punkte:", discoveredPoints.length);
}

function loadProgress() {
    const data = localStorage.getItem("fow_points");

    if (!data) {
        console.log("Keine gespeicherten Fog-Punkte gefunden.");
        return;
    }

    const points = JSON.parse(data);
    console.log("Geladene Fog-Punkte:", points.length);

    for (const [lat, lng] of points) {
        drawRevealCircle(lat, lng);
    }

    discoveredPoints = points;
    drawFog();
}

function resetProgress() {
    localStorage.removeItem("fow_points");
    localStorage.removeItem("fow_xp");
    localStorage.removeItem("fow_pois");

    playerXP = 0;
    playerLevel = 1;
    updateXPDisplay();

    for (const area of discoveredAreas) {
        map.removeLayer(area);
    }

    discoveredAreas = [];
    discoveredPoints = [];
    lastRevealPoint = null;
    lastAcceptedPoint = null;
    smoothedPoint = null;
    hasInitialFix = false;
    isFollowingUser = true;
    updateRecenterButtonVisibility();
    for (const poi of pois) {
        poi.discovered = false;
    }


    if (routeLine) {
        map.removeLayer(routeLine);
        routeLine = null;
    }

    routePoints = [];

    if (userMarker) {
        map.removeLayer(userMarker);
        userMarker = null;
    }

    drawFog();

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
map.on("dragstart", () => {
    isFollowingUser = false;
    updateRecenterButtonVisibility();
});

if (recenterButtonEl) {
    recenterButtonEl.addEventListener("click", () => {
        if (userMarker) {
            const userLatLng = userMarker.getLatLng();
            map.setView(userLatLng, map.getZoom());
            isFollowingUser = true;
            updateRecenterButtonVisibility();
        }
    });
}





