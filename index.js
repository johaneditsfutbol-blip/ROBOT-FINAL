process.env.TZ = 'America/Caracas';

const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ==============================================================================
// 1. CONFIGURACIONES GLOBALES
// ==============================================================================

const CONFIG_ICARO = {
    urlLogin: "https://administrativo.icarosoft.com/",
    urlLista: "https://administrativo.icarosoft.com/Listado_clientes_tickets/",
    user: "JOHANC",
    pass: "@VNjohanc16",
    selUser: '#id_sc_field_login',
    selPass: '#id_sc_field_pswd',
};

const CONFIG_VIDANET = { 
    url: "https://pagos.vidanet.net" 
};

const BUILDERBOT = {
    url: 'https://app.builderbot.cloud/api/v2/80c70b51-1737-4dad-9ee9-111cbc75174e/messages',
    token: 'bb-3441000d-f490-47bf-9c5a-273409fad976'
};

const PUSH_CONFIG = {
    supabaseUrl: "https://qyvmupeeldyggghegnke.supabase.co/rest/v1/push_tokens",
    supabaseKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF5dm11cGVlbGR5Z2dnaGVnbmtlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIxNzc1ODMsImV4cCI6MjA3Nzc1MzU4M30.srvwDtXyKvi9_CyuFfiJkrkX_kZz6lXEaqBW3F3A5Jo", 
    expoUrl: "https://exp.host/--/api/v2/push/send"
};

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// --- GESTIÓN DE NAVEGADORES INDEPENDIENTES ---
let browserRegistrador = null; // Para /pagar (Icaro)
let pageRegistrador = null;

let browserVidanet = null;     // Para /pagar-vidanet y /consultar
let pageVidanetDummy = null;

let browserServicios = null;   // Para /buscar-servicios (Robot V30)
let pageServicios = null;

let browserFinanzas = null;    // Para /buscar-finanzas (Robot V18)
let pageFinanzas = null;

// --- CONFIGURACIÓN BLINDADA (ESTO ES NUEVO) ---
const LAUNCH_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', // <--- OBLIGATORIO: Evita que Chrome explote la RAM en Railway
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--hide-scrollbars'
    // IMPORTANTE: Se eliminó '--single-process' porque congela los submits en Linux
];

// ==============================================================================
// 2. HERRAMIENTAS COMUNES (Notificaciones & Helpers Básicos)
// ==============================================================================

function notificarBuilderBot(datos) {
    return new Promise((resolve, reject) => {
        console.log("   🔔 [BOT] Enviando notificación...");
        const numero = datos.numero || datos; 
        if (!numero) { resolve(null); return; }

        const mensajeTexto = datos.mensaje || (typeof datos === 'string' ? datos : "Proceso finalizado.");
        const mensajeObj = { "content": mensajeTexto };
        if (datos.mediaUrl && datos.mediaUrl.startsWith('http')) mensajeObj.mediaUrl = datos.mediaUrl;

        const payload = JSON.stringify({
            "number": String(numero).replace(/\D/g, ''),
            "messages": mensajeObj, 
            "checkIfExists": false
        });

        const urlParts = new URL(BUILDERBOT.url);
        const req = https.request({
            hostname: urlParts.hostname,
            path: urlParts.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-builderbot': BUILDERBOT.token,
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data));
        });
        req.on('error', (e) => resolve(null));
        req.write(payload);
        req.end();
    });
}

async function gestionarNotificacionPush(idCliente, datos, esExito, mensajeDetalle) {
    try {
        console.log(`   📱 [PUSH MULTI-DEVICE] Procesando para ID entrada: ${idCliente}`);
        
        // 1. BUSCAR TODOS LOS TOKENS ASOCIADOS
        const urlGet = `${PUSH_CONFIG.supabaseUrl}?codigo_cliente=ilike.*${idCliente}*&select=expo_push_token,codigo_cliente`;
        
        const respSupabase = await fetch(urlGet, {
            method: 'GET',
            headers: {
                'apikey': PUSH_CONFIG.supabaseKey,
                'Authorization': `Bearer ${PUSH_CONFIG.supabaseKey}`,
                'Content-Type': 'application/json'
            }
        });

        if (!respSupabase.ok) return;
        const listaDispositivos = await respSupabase.json();
        
        // Si no hay dispositivos, salimos
        if (!listaDispositivos || !listaDispositivos.length) return;

        // Tomamos el codigo_cliente real del primer resultado (asumimos que todos son del mismo cliente)
        const codigoClienteReal = listaDispositivos[0].codigo_cliente;

        // Preparar el mensaje (igual que antes)
        let titulo = esExito ? "✅ PAGO CONFIRMADO" : "❌ PAGO NO PROCESADO";
        let cuerpo = esExito 
            ? `\n🆔 REF: #${datos.referencia}\n📅 FECHA: ${datos.fecha || new Date().toLocaleDateString()}\n💵 MONTO: ${datos.monto || "N/A"}\n\n🚀 Tu servicio será reactivado automáticamente.`
            : `\n🆔 REF: #${datos.referencia}\n⚠️ MOTIVO: ${mensajeDetalle}\n\nVerifica tu comprobante e intenta nuevamente.`;

        // 2. ENVIAR NOTIFICACIÓN A TODOS LOS TOKENS (Bucle Promesa)
        // Creamos una lista de promesas para enviar todos los push "al mismo tiempo"
        const promesasDeEnvio = listaDispositivos.map(dispositivo => {
            const token = dispositivo.expo_push_token;
            if (!token) return null; // Saltar si es nulo

            return fetch(PUSH_CONFIG.expoUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    to: token, // <--- Aquí cambia dinámicamente para cada celular
                    title: titulo,
                    body: cuerpo,
                    priority: "high",
                    sound: "default",
                    badge: 1,
                    data: { referencia: datos.referencia, estado: esExito ? 'success' : 'fail' }
                })
            });
        });

        // Esperamos a que se envíen todos (sin detener si uno falla)
        await Promise.all(promesasDeEnvio);
        console.log(`   🚀 Push enviado a ${promesasDeEnvio.length} dispositivos.`);

        // 3. GUARDAR EN HISTORIAL (SOLO UNA VEZ)
        const urlHistorial = PUSH_CONFIG.supabaseUrl.replace('push_tokens', 'historial_notificaciones');

        await fetch(urlHistorial, {
            method: 'POST',
            headers: {
                'apikey': PUSH_CONFIG.supabaseKey,
                'Authorization': `Bearer ${PUSH_CONFIG.supabaseKey}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
                codigo_cliente: codigoClienteReal,
                titulo: titulo,
                cuerpo: cuerpo,
                leido: false
            })
        });
        
        console.log(`   💾 Guardado en historial único para: ${codigoClienteReal}`);

    } catch (e) { 
        console.error("   ❌ [PUSH ERROR]:", e.message); 
    }
}

function descargarImagenTemporal(url) {
    return new Promise((resolve, reject) => {
        const nombreTemp = `temp_${Date.now()}.jpg`;
        const rutaTemp = path.resolve(__dirname, nombreTemp);
        const file = fs.createWriteStream(rutaTemp);
        https.get(url, (res) => {
            if (res.statusCode !== 200) { reject(new Error(`Status: ${res.statusCode}`)); return; }
            res.pipe(file);
            file.on('finish', () => file.close(() => resolve(rutaTemp)));
        }).on('error', (err) => { fs.unlink(rutaTemp, () => {}); reject(err); });
    });
}

async function subirComprobante(frame, rutaOUrl) {
    let rutaFinal = rutaOUrl;
    let esTemporal = false;
    if (rutaOUrl.startsWith('http')) {
        try { rutaFinal = await descargarImagenTemporal(rutaOUrl); esTemporal = true; } 
        catch (e) { console.log(`            ❌ Error descarga img: ${e.message}`); return false; }
    } else if (!fs.existsSync(rutaFinal)) return false;

    const input = await frame.$('input[type="file"]');
    if (input) {
        await input.uploadFile(rutaFinal);
        await frame.evaluate(() => {
            const el = document.querySelector('input[type="file"]');
            if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await esperar(5000);
        if (esTemporal) try { fs.unlinkSync(rutaFinal); } catch(e){}
        return true;
    }
    return false;
}

// Helpers de Interacción Icaro
async function clickPorTexto(frame, texto) {
    return await frame.evaluate((txt) => {
        const xpath = `//a[contains(., '${txt}')] | //span[contains(., '${txt}')] | //button[contains(., '${txt}')] | //div[contains(text(), '${txt}')]`;
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const el = result.singleNodeValue;
        if (el) { el.scrollIntoView(); el.click(); return true; }
        return false;
    }, texto);
}

async function seleccionarLetra(page, letra) {
    return await page.evaluate((txt) => {
        const selects = Array.from(document.querySelectorAll('select'));
        const targetSelect = selects.find(sel => Array.from(sel.options).some(opt => opt.text.includes(txt)));
        if (targetSelect) {
            const option = Array.from(targetSelect.options).find(opt => opt.text.includes(txt));
            targetSelect.value = option.value;
            targetSelect.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }
        return false;
    }, letra);
}

// ==============================================================================
// 3. MÓDULO ROBOT 1: REGISTRADOR DE PAGOS (ICARO + VIDANET)
// ==============================================================================

// --- HELPERS VIDANET (Restaurados Originales) ---
async function clickGeometrico(page, texto) {
    console.log(`      -> 📐 Buscando barra ancha: "${texto}"...`);
    const elemento = await page.evaluateHandle((txt) => {
        const norm = (s) => s ? s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") : "";
        const target = norm(txt);
        const all = Array.from(document.querySelectorAll('button, a, div, span'));
        const matches = all.filter(el => norm(el.innerText).includes(target) && el.offsetParent !== null);
        if (matches.length > 0) {
            matches.sort((a, b) => a.innerText.length - b.innerText.length);
            const ganador = matches[0];
            ganador.scrollIntoView({block: "center"});
            return ganador;
        }
        return null;
    }, texto);

    if (!elemento.asElement()) return false;
    const box = await elemento.boundingBox();
    if (!box) return false;

    let clickX = box.x + box.width / 2;
    if (box.width > 300) clickX = box.x + box.width - 80; 
    const clickY = box.y + box.height / 2;

    await page.mouse.click(clickX, clickY);
    return true;
}

async function clickCentroPuro(page, texto) {
    console.log(`      -> 🎯 Buscando botón normal: "${texto}"...`);
    const elemento = await page.evaluateHandle((txt) => {
        const norm = (s) => s ? s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") : "";
        const target = norm(txt);
        const all = Array.from(document.querySelectorAll('button, a, div, span, strong')); 
        const matches = all.filter(el => norm(el.innerText).includes(target) && el.offsetParent !== null);
        if (matches.length > 0) {
            matches.sort((a, b) => a.innerText.length - b.innerText.length);
            const ganador = matches[0];
            ganador.scrollIntoView({block: "center"});
            return ganador;
        }
        return null;
    }, texto);

    if (!elemento.asElement()) return false;
    const box = await elemento.boundingBox();
    if (!box) return false;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return true;
}

async function clickBotonValidar(page) {
    console.log(`      -> 🛡️ Buscando EXCLUSIVAMENTE botón Validar...`);
    const elemento = await page.evaluateHandle(() => {
        const all = Array.from(document.querySelectorAll('button, div, span, a'));
        const matches = all.filter(el => {
            const texto = el.innerText ? el.innerText.toLowerCase() : "";
            const tieneInput = el.querySelector('input'); 
            const esVisible = el.offsetParent !== null;
            return texto.includes("validar") && !tieneInput && esVisible;
        });
        if (matches.length > 0) {
            matches.sort((a, b) => a.innerText.length - b.innerText.length);
            const ganador = matches[0];
            ganador.scrollIntoView({block: "center"});
            return ganador;
        }
        return null;
    });

    if (!elemento.asElement()) return false;
    const box = await elemento.boundingBox();
    if (!box) return false;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return true;
}

async function manipularDeudas(page, modo, idsObjetivo = []) {
    // Selectores CSS Blindados
    const cssBadge = "span.bg-green-500"; 
    const cssDeudaTexto = "div.font-bold.text-gray-900"; 
    const cssPrecio = "div.text-2xl.text-green-700"; 

    console.log(`      ⚙️ Modo Deudas: ${modo}`); // <--- LOG RESTAURADO

    const limpiarSeleccion = async () => {
        console.log("      🧹 Limpiando selección inicial..."); // <--- LOG RESTAURADO
        const badges = await page.$$(cssBadge);
        for (const badge of badges) {
            try {
                const txt = await page.evaluate(e => e.innerText, badge);
                if (txt.includes("Seleccionada")) { 
                    await badge.click(); 
                    await esperar(300); 
                }
            } catch(e){}
        }
        await esperar(1000);
    };

    const candidatos = await page.$$(cssDeudaTexto);
    const elsDeuda = [];
    for(const el of candidatos) {
        if((await page.evaluate(e=>e.innerText, el)).includes("Deuda #")) elsDeuda.push(el);
    }
    
    if(elsDeuda.length === 0) return [];

    // --- MODO SCAN (GET) ---
    if(modo === 'SCAN') {
        await limpiarSeleccion();
        let res = [];
        for(const el of elsDeuda) {
            const id = await page.evaluate(e=>e.innerText.trim(), el);
            
            // Log opcional si quieres ver el escaneo paso a paso
            // console.log(`      🔍 Escaneando: ${id}`); 
            
            await el.click(); await esperar(800);
            const pEl = await page.$(cssPrecio);
            let m = pEl ? await page.evaluate(e=>e.innerText.trim(), pEl) : "0.00";
            res.push({ id_deuda: id, monto: m });
            await el.click(); await esperar(300);
        }
        return res;
    }

    // --- MODO SELECT (POST) ---
    if(modo === 'SELECT') {
        if(!idsObjetivo || idsObjetivo==="todas" || idsObjetivo.length===0) {
            console.log("      ✅ Pagando TODAS (Selección por defecto)."); // <--- LOG RESTAURADO
            return true;
        }

        await limpiarSeleccion();
        
        let c = 0;
        for(const el of elsDeuda) {
            const id = await page.evaluate(e=>e.innerText.trim(), el);
            if(idsObjetivo.includes(id)) { 
                console.log(`      🎯 Seleccionando: ${id}`); // <--- LOG RESTAURADO
                await el.click(); 
                c++; 
                await esperar(500); 
            }
        }
        
        if(c===0) throw new Error("Deudas no encontradas.");
        return true;
    }
}

// --- LOGICA DE REGISTRO ---

async function iniciarRegistrador() {
    if (browserRegistrador && browserRegistrador.isConnected()) return;
    console.log("🚀 [REGISTRADOR] Iniciando Icaro...");
    try {
        if(browserRegistrador) try{ await browserRegistrador.close(); }catch(e){}
        browserRegistrador = await puppeteer.launch({ headless: "new", defaultViewport: null, args: LAUNCH_ARGS });
        pageRegistrador = await browserRegistrador.newPage();
        // Aumentamos timeout a 60s
        await pageRegistrador.goto(CONFIG_ICARO.urlLogin, { waitUntil: 'networkidle2', timeout: 60000 });
        
        if (await pageRegistrador.$(CONFIG_ICARO.selUser)) {
            await pageRegistrador.type(CONFIG_ICARO.selUser, CONFIG_ICARO.user);
            await pageRegistrador.type(CONFIG_ICARO.selPass, CONFIG_ICARO.pass);
            await pageRegistrador.evaluate(() => {
                document.querySelectorAll('span').forEach(s => { if(s.innerText.includes('Login')) s.click(); });
            });
            await pageRegistrador.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
            console.log("✅ [REGISTRADOR] Icaro Login OK.");
        }
    } catch(e) {
        console.error("❌ Error iniciando Registrador:", e.message);
        browserRegistrador = null;
    }
}

async function registrarPagoWizard(idCliente, datos) {
    if (!browserRegistrador) { console.error("❌ Registrador no listo."); return; }
    console.log(`\n🤖 --- [ICARO] PAGO ID: ${idCliente} ---`);
    
    const page = await browserRegistrador.newPage();
    page.on('dialog', async d => {
        console.log(`      👀 ALERTA: "${d.message()}" -> ACEPTADA.`);
        await d.accept(); 
    });

    try {
        await page.goto(CONFIG_ICARO.urlLista, { waitUntil: 'networkidle2' });
        if (await page.$('#SC_fast_search_top')) {
            await page.type('#SC_fast_search_top', idCliente);
            await page.click('#SC_fast_search_submit_top');
            await esperar(3000); 
        }

        console.log("   🟢 Click 'Registrar pago'...");
        const frames = page.frames();
        let btnEncontrado = false;
        for (const f of frames) {
            const btn = await f.$('a[id*="registrar_pagos"], span[id*="registrar_pagos"]');
            if (btn) { await btn.click(); btnEncontrado = true; break; }
        }
        if (!btnEncontrado) throw new Error("Botón verde no encontrado.");

        await esperar(5000); 
        
        // Helper interno para este wizard
        const encontrarFrameDelWizard = async (p) => {
            const frames = p.frames();
            for (const frame of frames) { if (await frame.$('#id_sc_field_id_servicio')) return frame; }
            return null;
        }

        let wFrame = await encontrarFrameDelWizard(page);
        if (!wFrame) { await esperar(3000); wFrame = await encontrarFrameDelWizard(page); }
        if (!wFrame) throw new Error("No se detectó el formulario.");

        // --- PASO 1: SELECCIÓN ESTRICTA POR DIRECCIÓN ---
        console.log(`   1️⃣ Paso 1: Buscando coincidencia exacta con: "${datos.direccion}"`);
        
        const resultadoSeleccion = await wFrame.evaluate((textoA_Buscar) => {
            const el = document.querySelector('#id_sc_field_id_servicio');
            if (!el) return { exito: false, msg: "Error interno: Select no encontrado" };

            if (!textoA_Buscar || textoA_Buscar.trim() === "") {
                return { exito: false, msg: "ABORTADO: No se envió el dato 'direccion' en la solicitud." };
            }

            // CASO: Direccion no detectada
            if (textoA_Buscar === "No detectada" && el.options.length > 1) {
                el.selectedIndex = 1;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
                return { exito: true, opcion: "Automática (No detectada)" };
            }

            for (let i = 0; i < el.options.length; i++) {
                if (el.options[i].text.includes(textoA_Buscar)) {
                    el.selectedIndex = i;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                    return { exito: true, opcion: el.options[i].text };
                }
            }
            return { exito: false, msg: `ABORTADO: Ninguna opción contiene "${textoA_Buscar}"` };
        }, datos.direccion);

        if (!resultadoSeleccion.exito) {
            const errorMsg = `❌ ${resultadoSeleccion.msg}`;
            console.error(errorMsg);
            await notificarBuilderBot({ numero: datos.numero, mensaje: errorMsg });
            await gestionarNotificacionPush(idCliente, datos, false, "La dirección del servicio no coincide.");
            await page.close();
            return;
        }

        console.log(`      ✅ Servicio Seleccionado: "${resultadoSeleccion.opcion}"`);
        await esperar(2000); 
        await clickPorTexto(wFrame, 'Próximo');
        await esperar(4000);

        // --- PASO 2 ---
        console.log("   2️⃣ Paso 2: Tipo y Forma");
        
        // Helper interno
        const seleccionarComoServicio = async (frame, idExacto, textoBuscar) => {
            console.log(`      -> Intentando seleccionar "${textoBuscar}" en #${idExacto}`);
            return await frame.evaluate((id, txt) => {
                const el = document.getElementById(id);
                const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                const busqueda = norm(txt);
                const opcion = Array.from(el.options).find(opt => norm(opt.text).includes(busqueda));
                if (opcion) {
                    el.value = opcion.value;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }
                return false;
            }, idExacto, textoBuscar);
        };

        if(datos.tipoPago) await seleccionarComoServicio(wFrame, 'id_sc_field_tipo_pago', datos.tipoPago);
        await esperar(1500);
        if(datos.formaPago) await seleccionarComoServicio(wFrame, 'id_sc_field_forma_pago', datos.formaPago);
        await esperar(2000); 
        await clickPorTexto(wFrame, 'Próximo');
        await esperar(3000);

        // --- PASO 3 ---
        console.log("   3️⃣ Paso 3: Datos Financieros");

        // Helper interno
        const escribirBlindado = async (p, frame, etiquetaVisual, valor) => {
            console.log(`      -> 🛡️ Escribiendo "${valor}" en [${etiquetaVisual}]`);
            const idInput = await frame.evaluate((txt) => {
                let el = null;
                if (txt.includes("Monto")) el = document.querySelector('input[id*="monto"]');
                if (txt.includes("Referencia")) el = document.querySelector('input[id*="referencia"]');
                if (txt.includes("Fecha")) el = document.querySelector('input[id*="fecha"]');
                if (!el) {
                    const xpath = `//tr[contains(., '${txt}')]//input[not(@type='hidden')]`;
                    const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    el = result.singleNodeValue;
                }
                return el ? el.id : null;
            }, etiquetaVisual);

            if(idInput) {
                await frame.click(`#${idInput}`, {clickCount:3});
                await p.keyboard.press('Backspace');
                await esperar(100);
                await p.keyboard.type(String(valor), {delay:100});
                await frame.evaluate(() => { const t = document.querySelector('.scFormHeader')||document.body; t.click(); });
                console.log(`            ✅ Escrito.`);
            } else {
                console.log(`            ❌ ERROR: Campo ${etiquetaVisual} no encontrado.`);
            }
        };

        await escribirBlindado(page, wFrame, 'Monto', datos.monto);
        console.log("          🛑 CUARENTENA: Esperando 8s...");
        await esperar(8000); 
        await escribirBlindado(page, wFrame, 'Referencia', datos.referencia);
        await esperar(2000);
        if(datos.fecha) await escribirBlindado(page, wFrame, 'Fecha', datos.fecha);

        // TITULAR (OPCIONAL)
        if (datos.titular_cuenta && datos.titular_cuenta.trim() !== "") {
            console.log(`      📝 Escribiendo Titular: "${datos.titular_cuenta}"`);
            const descArea = await wFrame.$('#id_sc_field_descripcion');
            if(descArea) {
                await descArea.click({clickCount:3});
                await page.keyboard.press('Backspace');
                await descArea.type(datos.titular_cuenta, {delay:50});
            }
        }

        await esperar(1000); 
        console.log("   ➡️ Cambiando de pantalla...");
        await clickPorTexto(wFrame, 'Próximo'); 
        
        // ESPERA CRÍTICA PARA QUE EL FRAME NUEVO CARGUE
        await esperar(5000); 

        // 🚨 RE-CAPTURA DEL FRAME (ESTO ES LO QUE TE FALTA) 🚨
        // La variable wFrame vieja ya no sirve. Buscamos el frame que tenga el input de archivo.
        wFrame = page.frames().find(f => f.url().includes('form_') || f.name().includes('nm_iframe'));
        
        // Si no lo encontramos por nombre, lo buscamos por contenido (el input file)
        if (!wFrame) {
            console.log("   ⚠️ Buscando frame por contenido (input file)...");
            for (const f of page.frames()) {
                const tieneFile = await f.$('input[type="file"]');
                if (tieneFile) { wFrame = f; break; }
            }
        }
        
        if (!wFrame) throw new Error("No se encontró el frame de la pantalla 2 (Imagen).");
        console.log("   ✅ Frame de Pantalla 2 capturado.");

// --- PASO 4: EL BLOQUEO DE SALIDA (FIX RAILWAY) ---
        console.log("   4️⃣ Paso 4: Submit con 'Promise.all' (Obligatorio en Docker)");
        
        if(datos.rutaImagen) {
            await subirComprobante(wFrame, datos.rutaImagen);
            await esperar(3000); 
        }

        // 1. Preparamos el terreno (Quitar foco y forzar modo insertar)
        await wFrame.evaluate(() => {
            document.activeElement.blur(); 
            // FORZAMOS EL MODO 'INCLUIR' EN EL FORMULARIO OCULTO
            const inputOp = document.querySelector('input[name="nmgp_opcao"]');
            if(inputOp) inputOp.value = 'incluir';
        });
        await esperar(1000);

        console.log("   🚀 EJECUTANDO SUBMIT SINCRONIZADO...");

        // 2. EL CAMBIO CLAVE: Disparamos el envío Y esperamos la navegación AL MISMO TIEMPO.
        // Esto evita que el script continúe si la red no ha respondido.
        try {
            await Promise.all([
                // Promesa A: Esperar a que la página haga algo (navegar o recargar)
                wFrame.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
                    .catch(e => console.log("   ⚠️ No hubo navegación clásica, pero seguimos.")),
                
                // Promesa B: La acción que provoca el envío (Submit directo del Formulario F1)
                wFrame.evaluate(() => {
                    if(document.F1) {
                        document.F1.submit(); // Envío nativo (Infalible)
                    } else {
                        // Fallback: Click al botón si no hay F1
                        const btn = document.getElementById('sc_b_ins_t') || document.getElementById('sc_b_ins_b');
                        if(btn) btn.click();
                    }
                })
            ]);
        } catch (error) {
            console.log("   ⚠️ Error en Promise.all (Normal si es AJAX):", error.message);
            // Si falla la navegación, esperamos un NetworkIdle manual
            await page.waitForNetworkIdle({ idleTime: 2000, timeout: 10000 }).catch(()=>{});
        }

        console.log("   ✅ Respuesta recibida.");

        // 3. FOTO FINAL OBLIGATORIA
        await page.screenshot({ path: `final_railway_${datos.referencia}.png` });
        
        // DALE 2 SEGUNDOS DE GRACIA AL SERVIDOR ANTES DE MATAR EL PROCESO
        await esperar(2000);

        await page.close();

        // Notificaciones
        await notificarBuilderBot(datos);
        await gestionarNotificacionPush(idCliente, datos, true);

    } catch(e) {
        console.error("❌ ERROR EN SEGUNDO PLANO ICARO:", e.message);
        await notificarBuilderBot({ numero: datos.numero, mensaje: `Error técnico: ${e.message}` });
        await gestionarNotificacionPush(idCliente, datos, false, "Ocurrió un error técnico al registrar.");
        if(page && !page.isClosed()) await page.close();
    }
}

async function iniciarVidanet() {
    if (browserVidanet && browserVidanet.isConnected()) return;
    console.log("🚀 [VIDANET] Iniciando...");
    try {
        if(browserVidanet) try{ await browserVidanet.close(); }catch(e){}
        browserVidanet = await puppeteer.launch({ headless: "new", defaultViewport: null, args: LAUNCH_ARGS });
        pageVidanetDummy = await browserVidanet.newPage();
        try { await pageVidanetDummy.goto(CONFIG_VIDANET.url, { waitUntil: 'networkidle2', timeout: 60000 }); } catch(e){}
        console.log("✅ [VIDANET] Listo.");
    } catch(e) {
        console.error("❌ Error iniciando Vidanet:", e.message);
        browserVidanet = null;
    }
}

async function procesarPagoVidanet(datos) {
    if(!browserVidanet) await iniciarVidanet();
    console.log(`\n🤖 --- [VIDANET] PAGO REF: ${datos.referencia} ---`);
    const page = await browserVidanet.newPage();
    page.setDefaultNavigationTimeout(60000);
    let resultado = "", esExito = false;

    try {
        await page.goto(CONFIG_VIDANET.url, {waitUntil:'domcontentloaded'}); await esperar(1000);
        await seleccionarLetra(page, datos.letra);
        const inp = await page.$('input[type="text"]');
        if(inp) { await inp.click({clickCount:3}); await inp.type(datos.cedula); await page.keyboard.press('Enter'); }

        try {
            await page.waitForFunction(() => {
                const els = document.querySelectorAll('div.font-bold.text-gray-900');
                return Array.from(els).some(e => e.innerText.includes('Deuda #'));
            }, {timeout:15000});
        } catch(e) { throw new Error("No hay deudas o no cargó."); }
        await esperar(2000);

        let ids = datos.id_deuda;
        if(typeof ids === 'string' && ids !== 'todas') ids = [ids];
        await manipularDeudas(page, 'SELECT', ids);

        if(!(await clickGeometrico(page, "Continuar"))) throw new Error("Fallo click Continuar");
        
        console.log("      ⏳ Bancos...");
        try { await page.waitForFunction(()=>document.body.innerText.includes('Banco'), {timeout:8000}); }
        catch(e) { await clickGeometrico(page, "Continuar"); await esperar(2000); }

        const bKey = datos.banco.includes("Venezuela") ? "Venezuela" : "Credito";
        if(!(await clickCentroPuro(page, bKey))) throw new Error("Banco no encontrado");
        await esperar(2000);
        await clickCentroPuro(page, "Entendido");
        await esperar(1500);

        const refInp = await page.$('input[placeholder*="Referencia"]') || (await page.$$('input[type="text"]')).pop();
        if(refInp) { await refInp.click({clickCount:3}); await refInp.type(datos.referencia); }

        console.log("      ⏳ Validando...");
        await esperar(1000);
        const clickHecho = await clickBotonValidar(page);
        if (!clickHecho) {
            console.log("      ⚠️ Falló click Validar. Usando ENTER...");
            await page.keyboard.press('Enter');
        }
        await esperar(8000);

        const txt = await page.evaluate(()=>document.body.innerText);
        if(txt.includes("Referencia no encontrada")) {
            resultado = "Vidanet: Referencia no encontrada."; esExito=false;
        } else if(txt.includes("Detalle") || txt.includes("Resumen")) {
            resultado = "¡Pago Vidanet Exitoso!"; esExito=true;
        } else {
            resultado = "Resultado ambiguo. Verificar."; esExito=false;
        }

        await page.close();
        await notificarBuilderBot({numero:datos.numero, mensaje:resultado});
        await gestionarNotificacionPush(datos.cedula, datos, esExito, resultado);

    } catch(e) {
        console.error("❌ ERROR VIDANET:", e.message);
        await notificarBuilderBot({numero:datos.numero, mensaje:`Error Vidanet: ${e.message}`});
        await gestionarNotificacionPush(datos.cedula, datos, false, e.message);
        if(page) await page.close();
    }
}

// ==============================================================================
// 4. MÓDULO ROBOT 2: EXTRACTOR DE SERVICIOS (V30 - ORIGINAL)
// ==============================================================================

async function iniciarServicios() {
    if (browserServicios && browserServicios.isConnected()) return;
    console.log("🚀 [SERVICIOS] Iniciando Motor...");
    try {
        if(browserServicios) try{ await browserServicios.close(); }catch(e){}
        browserServicios = await puppeteer.launch({ headless: "new", defaultViewport: null, args: LAUNCH_ARGS });
        pageServicios = await browserServicios.newPage();
        await pageServicios.goto(CONFIG_ICARO.urlLogin, {waitUntil:'networkidle2', timeout: 60000});
        
        if(await pageServicios.$(CONFIG_ICARO.selUser)) {
            await pageServicios.type(CONFIG_ICARO.selUser, CONFIG_ICARO.user);
            await pageServicios.type(CONFIG_ICARO.selPass, CONFIG_ICARO.pass);
            await pageServicios.evaluate(() => {
                document.querySelectorAll('span').forEach(s => { if(s.innerText.includes('Login')) s.click(); });
            });
            await pageServicios.waitForNavigation({waitUntil:'networkidle2', timeout: 60000});
            console.log("✅ [SERVICIOS] Login OK.");
        }
    } catch(e) {
        console.error("❌ Error iniciando Servicios:", e.message);
        browserServicios = null;
    }
}

async function escanearFramesServicios(page) {
    for (const frame of page.frames()) {
        try {
            const data = await frame.evaluate(() => {
                const planesElements = document.querySelectorAll('span[id^="id_sc_field_codigo_producto_"]');
                if (planesElements.length === 0) return null;
                const resultados = [];
                let nombreGlobal = "N/A";

                planesElements.forEach((elPlan, index) => {
                    const fila = elPlan.closest('tr[id^="SC_ancor"]');
                    if (fila) {
                        const limpiar = (texto, etiqueta) => {
                            if (!texto) return "N/A";
                            if (etiqueta) texto = texto.replace(etiqueta, '');
                            return texto.replace(/[\n\r]+/g, ' ').trim();
                        };
                        const getTexto = (partialId) => {
                            const el = fila.querySelector(`[id^="${partialId}"]`);
                            return el ? el.innerText : "";
                        };

                        let plan = getTexto("id_sc_field_codigo_producto_");
                        plan = limpiar(plan, "Plan:");
                        let ip = getTexto("id_sc_field_ip_servicio_");
                        ip = limpiar(ip, "Ip Servicio:");

                        if (nombreGlobal === "N/A") {
                            let cliente = getTexto("id_sc_field_id_cliente_") || getTexto("id_sc_field_nombre_cliente_");
                            nombreGlobal = limpiar(cliente, "Cliente:");
                        }

                        const elDir = fila.querySelector('a[id^="bdireccion_servicio"]');
                        let dir = "No detectada";
                        if (elDir) {
                            dir = elDir.getAttribute('title') || "No detectada";
                            dir = dir.replace(/^B\/\s*/i, '').trim();
                        }

                        const estado = getTexto("id_sc_field_estado_");
                        const saldo = getTexto("id_sc_field_saldo_");
                        const fecha = getTexto("id_sc_field_fecha_corte_actual_");

                        resultados.push({
                            numero_servicio: index + 1,
                            plan: plan,
                            ip: ip,
                            estado: estado || "N/A",
                            saldo: saldo || "N/A",
                            fecha_corte: fecha || "N/A",
                            direccion: dir
                        });
                    }
                });
                return { nombre_cliente: nombreGlobal, servicios: resultados };
            });
            if (data) return data; 
        } catch(e) {}
    }
    return null;
}

async function esperarServicios(page) {
    console.log(`      ⏳ Escaneando tabla de servicios...`);
    for (let i = 0; i < 8; i++) { 
        const data = await escanearFramesServicios(page);
        if (data && data.servicios.length > 0) {
            console.log(`      ✅ Datos capturados (${data.servicios.length} servicios).`);
            return data;
        }
        await esperar(1000);
    }
    console.log("      ⚠️ Tiempo agotado o tabla vacía.");
    return null;
}

async function buscarClienteServicios(idBusqueda) {
    if (!browserServicios) throw new Error("Sistema iniciando...");
    console.log(`🤖 [SERVICIOS] Buscando: ${idBusqueda}`);
    
    // --- LÓGICA ORIGINAL RESTAURADA ---
    const page = await browserServicios.newPage();
    page.setDefaultNavigationTimeout(60000);

    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
        else req.continue();
    });

    try {
        await page.goto(CONFIG_ICARO.urlLista, { waitUntil: 'networkidle2' });

        const searchIn = '#SC_fast_search_top'; 
        if (await page.$(searchIn)) {
            await page.type(searchIn, idBusqueda);
            await page.click('#SC_fast_search_submit_top');
            await esperar(3000); 
        }

        const mensajeError = await page.evaluate(() => {
            const el = document.querySelector('#sc_grid_body');
            return el ? el.innerText.trim() : null;
        });
        if (mensajeError && mensajeError.includes('No hay registros')) {
            await page.close();
            return { success: false, mensaje: "No hay registros" };
        }

        try { await page.waitForSelector('.fa-user-edit', { timeout: 10000 }); } 
        catch(e) { throw new Error("Cliente no encontrado."); }

        const newTargetPromise = browserServicios.waitForTarget(target => target.opener() === page.target());
        await page.click('.fa-user-edit');
        const tab = await (await newTargetPromise).page();
        
        await tab.setRequestInterception(true);
        tab.on('request', (req) => {
            if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await tab.bringToFront();
        await esperar(4000); 

        // Helper interno original
        const encontrarFrame = async (selector) => {
            for (const frame of tab.frames()) {
                try { if (await frame.$(selector)) return frame; } catch(e){}
            }
            return null;
        };

        // --- A. DATOS FIJOS ---
        let codigo = "N/A", movil = "N/A", fijo = "N/A";
        const frameDatos = await encontrarFrame('#id_sc_field_cod_cliente');
        
        if (frameDatos) {
            const datos = await frameDatos.evaluate(() => {
                const getVal = (id) => { 
                    const el = document.querySelector(id); return el ? el.value : "N/A"; 
                };
                return {
                    c: getVal('#id_sc_field_cod_cliente'),
                    m: getVal('#id_sc_field_telefono_movil'),
                    f: getVal('#id_sc_field_telefono_fijo')
                };
            });
            codigo = datos.c; movil = datos.m; fijo = datos.f;
            console.log("      ✅ Inputs extraídos.");
        }

        // --- B. LINK (Lógica Original con Timeout 1.5s) ---
        let linkPago = "No capturado";
        const frameLink = await encontrarFrame('#sc_copiar_top');
        if (frameLink) {
            try {
                const dialogPromise = new Promise(resolve => {
                    const t = setTimeout(() => resolve(null), 1500); 
                    tab.once('dialog', async dialog => {
                        clearTimeout(t);
                        linkPago = dialog.message().replace("Texto copiado con éxito:", "").trim();
                        await dialog.accept(); 
                        resolve(true);
                    });
                });
                await frameLink.click('#sc_copiar_top');
                await dialogPromise;
                if(linkPago !== "No capturado") console.log("      ✅ Link copiado.");
            } catch (e) {}
        }

        // --- C. SERVICIOS ---
        console.log("      ⬇️ Escaneando servicios...");
        const frameTabs = await encontrarFrame('#cel2 a');
        if (frameTabs) {
             try { await frameTabs.click('#cel2 a'); await esperar(1500); } catch(e){}
        }
        
        // Aquí usa la función externa esperarServicios (que ya incluye escanearFramesServicios)
        let resultado = await esperarServicios(tab);
        let nombreCliente = "N/A";
        let listaServicios = [];

        if (resultado) {
            nombreCliente = resultado.nombre_cliente || "N/A";
            listaServicios = resultado.servicios || [];
        }

        await tab.close();
        await page.close();

        return {
            id_busqueda: idBusqueda,
            nombre_cliente: nombreCliente,
            codigo_cliente: codigo,
            movil: movil,
            fijo: fijo,
            link_pago: linkPago,
            servicios: listaServicios
        };

    } catch (error) {
        if(page && !page.isClosed()) await page.close();
        throw error;
    }
}

// ==============================================================================
// 5. MÓDULO ROBOT 3: EXTRACTOR DE FINANZAS (V18 - ORIGINAL)
// ==============================================================================

async function iniciarFinanzas() {
    if (browserFinanzas && browserFinanzas.isConnected()) return;
    console.log("🚀 [FINANZAS] Iniciando Motor...");
    try {
        if(browserFinanzas) try{ await browserFinanzas.close(); }catch(e){}
        browserFinanzas = await puppeteer.launch({ headless: "new", defaultViewport: null, args: LAUNCH_ARGS });
        pageFinanzas = await browserFinanzas.newPage();
        await pageFinanzas.goto(CONFIG_ICARO.urlLogin, { waitUntil: 'networkidle2', timeout: 60000 });
        
        if(await pageFinanzas.$(CONFIG_ICARO.selUser)) {
            await pageFinanzas.type(CONFIG_ICARO.selUser, CONFIG_ICARO.user);
            await pageFinanzas.type(CONFIG_ICARO.selPass, CONFIG_ICARO.pass);
            await pageFinanzas.evaluate(() => {
                document.querySelectorAll('span').forEach(s => { if(s.innerText.includes('Login')) s.click(); });
            });
            await pageFinanzas.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
            console.log("✅ [FINANZAS] Login OK.");
        }
    } catch(e) {
        console.error("❌ Error iniciando Finanzas:", e.message);
        browserFinanzas = null;
    }
}

async function escanearFramesFinanzas(page, tipoObjetivo) {
    for (const frame of page.frames()) {
        try {
            const data = await frame.evaluate((tipo) => {
                const rows = document.querySelectorAll('tr[id^="SC_ancor"]');
                
                // --- FACTURAS ---
                if (tipo === 'facturas') {
                    if (rows.length === 0) return null;
                    let facturas = [];
                    const esTablaFactura = document.querySelector('[id^="id_sc_field_nro_factura"]');
                    if (!esTablaFactura && rows.length > 0) return null;

                    rows.forEach(r => {
                        const getNro = r.querySelector('[id^="id_sc_field_nro_factura"]');
                        if (getNro) {
                            const getTxt = (id) => r.querySelector(`[id^="${id}"]`)?.innerText.trim() || "";
                            facturas.push({
                                numero: getTxt('id_sc_field_nro_factura'),
                                fecha: getTxt('id_sc_field_fecha_emision'),
                                estado: getTxt('id_sc_field_status'),
                                monto: getTxt('id_sc_field_total_neto'),
                                saldo: getTxt('id_sc_field_saldo')
                            });
                        }
                    });
                    return facturas.length ? facturas : null;
                }

                // --- TRANSACCIONES ---
                if (tipo === 'transacciones') {
                    if (rows.length === 0) return null;
                    let trans = [];
                    const esTablaTrans = document.querySelector('[id^="id_sc_field_referencia"]');
                    if (!esTablaTrans) return null;

                    rows.forEach(r => {
                        const getRef = r.querySelector('[id^="id_sc_field_referencia"]');
                        if (getRef) {
                            const getTxt = (id) => r.querySelector(`[id^="${id}"]`)?.innerText.trim() || "";
                            trans.push({
                                tipo: getTxt('id_sc_field_nombtipo'),
                                forma: getTxt('id_sc_field_nombforma'),
                                referencia: getTxt('id_sc_field_referencia'),
                                monto_bs: getTxt('id_sc_field_monto_bs'),
                                fecha: getTxt('id_sc_field_fecha_transaccion'),
                                status: getTxt('id_sc_field_status')
                            });
                        }
                    });
                    return trans.length ? trans : null;
                }
            }, tipoObjetivo);

            if (data) return data; 
        } catch(e) {}
    }
    return null;
}

async function esperarYExtraerFinanzas(page, tipo, intentosMax = 5) {
    console.log(`      ⏳ Esperando datos de '${tipo}'...`);
    for (let i = 0; i < intentosMax; i++) {
        const data = await escanearFramesFinanzas(page, tipo);
        if (data) {
            console.log("      ✅ Datos capturados.");
            return data;
        }
        await esperar(2000); 
    }
    console.log("      ⚠️ Tiempo agotado. No se detectaron datos.");
    return null;
}

async function buscarClienteFinanzas(idBusqueda) {
    if(!browserFinanzas) throw new Error("Sistema iniciando...");
    console.log(`🤖 [FINANZAS] Procesando: ${idBusqueda}`);
    const page = await browserFinanzas.newPage();

    try {
        await page.goto(CONFIG_ICARO.urlLista, {waitUntil:'networkidle2'});
        if(await page.$('#SC_fast_search_top')) {
            await page.type('#SC_fast_search_top', idBusqueda);
            await page.click('#SC_fast_search_submit_top');
            await esperar(5000);
        }
        await page.waitForSelector('.fa-user-edit', {timeout:15000});
        const newTarget = browserFinanzas.waitForTarget(t => t.opener() === page.target());
        await page.click('.fa-user-edit');
        const tab = await (await newTarget).page();
        await tab.bringToFront(); await esperar(4000);

        // Facturas
        console.log("      ⬇️ Facturas...");
        try { await tab.click('#cel3 a'); await esperar(3000); } catch(e){}
        let facturas = await esperarYExtraerFinanzas(tab, 'facturas', 5);

        // Transacciones
        console.log("      ⬇️ Transacciones...");
        let clickTrans = false;
        for (const frame of tab.frames()) {
            try {
                const clickeado = await frame.evaluate(() => {
                    const els = Array.from(document.querySelectorAll('a, span, div'));
                    const target = els.find(el => el.innerText.toUpperCase().includes("TRANSACCIONES"));
                    if (target) { target.click(); return true; }
                    return false;
                });
                if (clickeado) { clickTrans = true; break; }
            } catch(e) {}
        }

        let transacciones = [];
        if (clickTrans) {
            console.log("      (Clic realizado. ESPERANDO 18 SEGUNDOS...)");
            await esperar(18000); 
            transacciones = await esperarYExtraerFinanzas(tab, 'transacciones', 5);
        } else {
            console.log("      ⚠️ No encontré botón 'Transacciones'.");
        }

        await tab.close(); await page.close();
        return { id: idBusqueda, facturas: facturas || [], transacciones: transacciones || [] };

    } catch(e) { if(page) await page.close(); throw e; }
}

// ==============================================================================
// 6. ENDPOINTS API (RUTAS UNIFICADAS)
// ==============================================================================

// 1. REGISTRAR PAGO ICARO
app.post('/pagar', (req, res) => {
    const { id, datos } = req.body;
    if (!id || !datos) return res.status(400).json({ error: "Faltan datos" });
    console.log(`\n📨 Solicitud ICARO recibida ID: ${id}.`);
    res.json({ status: "OK", message: "Procesando Icaro..." });
    registrarPagoWizard(id, datos);
});

// 2. REGISTRAR PAGO VIDANET
app.post('/pagar-vidanet', (req, res) => {
    const { datos } = req.body;
    if (!datos) return res.status(400).json({ error: "Faltan datos" });
    console.log(`\n📨 Solicitud VIDANET recibida.`);
    res.json({ status: "OK", message: "Procesando Vidanet..." });
    procesarPagoVidanet(datos);
});

// 3. CONSULTAR DEUDAS VIDANET (GET)
app.get('/consultar-deudas-vidanet', async (req, res) => {
    const { letra, cedula } = req.query; 
    if (!letra || !cedula) return res.status(400).json({ error: "Faltan datos" });
    console.log(`\n🔍 [VIDANET] Consultando: ${letra}-${cedula}`);
    
    if (!browserVidanet) await iniciarVidanet();
    const page = await browserVidanet.newPage();
    try {
        page.setDefaultNavigationTimeout(60000);
        await page.goto(CONFIG_VIDANET.url, { waitUntil: 'domcontentloaded' }); await esperar(1000);
        await seleccionarLetra(page, letra); 
        const inp = await page.$('input[type="text"]');
        if (inp) { await inp.click({clickCount:3}); await inp.type(cedula); await page.keyboard.press('Enter'); }
        
        try {
            await page.waitForFunction(() => {
                const hayDeuda = document.querySelectorAll('div.font-bold.text-gray-900').length > 0;
                const hayError = document.body.innerText.includes('no encontrada') || document.body.innerText.includes('No existe');
                return hayDeuda || hayError;
            }, { timeout: 30000 });
        } catch (e) {
            await page.screenshot({ path: 'debug-vidanet.png' });
            throw new Error("Timeout espera. Ver debug-vidanet.png");
        }
        
        const txt = await page.evaluate(() => document.body.innerText);
        if (txt.includes("no encontrada") || txt.includes("No existe")) {
            await page.close(); return res.json({ success: true, deudas: [], mensaje: "Sin deudas." });
        }
        await esperar(1000);
        const lista = await manipularDeudas(page, 'SCAN');
        await page.close();
        res.json({ success: true, deudas: lista });
    } catch (e) {
        if(!page.isClosed()) await page.close();
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- RUTA PARA VER LAS FOTOS DE EVIDENCIA ---
app.get('/ver-foto/:nombre', (req, res) => {
    const nombreArchivo = req.params.nombre; // El nombre que le pusiste en el screenshot
    const rutaCompleta = path.resolve(__dirname, nombreArchivo);

    if (fs.existsSync(rutaCompleta)) {
        res.sendFile(rutaCompleta);
    } else {
        res.status(404).send(`
            <h1>❌ Foto no encontrada</h1>
            <p>Buscando: ${nombreArchivo}</p>
            <p><b>Posibles causas:</b></p>
            <ul>
                <li>El nombre está mal escrito.</li>
                <li>El robot no llegó a tomar la foto.</li>
                <li><b>Railway se reinició:</b> Recuerda que cada vez que haces Deploy o el server crashea, los archivos se borran.</li>
            </ul>
        `);
    }
});

// 4. BUSCAR SERVICIOS (ROBOT 2) - *RUTA NUEVA: /buscar-servicios*
app.get('/buscar-servicios', async (req, res) => {
    try {
        const datos = await buscarClienteServicios(req.query.id);
        res.json({ success: true, data: datos });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// 5. BUSCAR FINANZAS (ROBOT 3) - *RUTA NUEVA: /buscar-finanzas*
app.get('/buscar-finanzas', async (req, res) => {
    try {
        const datos = await buscarClienteFinanzas(req.query.id);
        res.json({ success: true, data: datos });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- RUTA DE SALUD (Vital para que Railway sepa si el server vive) ---
app.get('/health', (req, res) => {
    // Si podemos responder esto, es que el event loop de Node funciona
    res.status(200).send('OK - Alive');
});

app.get('/', (req, res) => res.send("🤖 MEGA-ROBOT UNIFICADO ACTIVO"));

// ==============================================================================
// 7. ARRANQUE Y MANTENIMIENTO
// ==============================================================================

app.listen(PORT, async () => {
    console.log(`\n🌍 MEGA-SERVIDOR ACTIVO EN PUERTO: ${PORT}`);
    
    // Arranque Inicial de TODOS los motores
    await iniciarRegistrador();
    await iniciarVidanet();
    await iniciarServicios();
    await iniciarFinanzas();

    // --- CICLOS DE MANTENIMIENTO INDEPENDIENTES ---

    // 1. Registradores (Cada 5 min)
    setInterval(async () => {
        console.log("\n♻️ [MANT] Reiniciando Registradores...");
        if (browserRegistrador) { try{await browserRegistrador.close();}catch(e){} browserRegistrador=null; }
        if (browserVidanet) { try{await browserVidanet.close();}catch(e){} browserVidanet=null; }
        await iniciarRegistrador();
        await iniciarVidanet();
    }, 900000);

    // 2. Servicios & Finanzas (Cada 10 min - Sincronizados para ahorrar recursos)
    setInterval(async () => {
        console.log("\n♻️ [MANT] Reiniciando Extractores...");
        if (browserServicios) { try{await browserServicios.close();}catch(e){} browserServicios=null; }
        if (browserFinanzas) { try{await browserFinanzas.close();}catch(e){} browserFinanzas=null; }
        await iniciarServicios();
        await iniciarFinanzas();
    }, 900000);

    // MONITOR DE RAM (Pégalo antes de cerrar el app.listen)
    setInterval(() => {
        const used = process.memoryUsage().rss / 1024 / 1024;
        console.log(`📊 RAM Usada: ${Math.round(used * 100) / 100} MB`);
    }, 30000);

});

// ==============================================================================
// 8. ESCUDO DE PROTECCIÓN (PARA QUE NO SE CAIGA EL SERVER)
// ==============================================================================

process.on('uncaughtException', (err) => {
    console.error('🔥 [CRITICAL] Error no capturado (Server sigue vivo):', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [WARNING] Promesa rechazada sin manejo:', reason instanceof Error ? reason.message : reason);
});
