require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_URL;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_LOCATION_ID = process.env.SHOPIFY_LOCATION_ID;

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt) {
        return cachedToken;
    }
    try {
        const tokenResponse = await axios.post(`https://${SHOPIFY_DOMAIN}/admin/oauth/access_token`, {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: "client_credentials"
        });
        cachedToken = tokenResponse.data.access_token;
        tokenExpiresAt = Date.now() + (tokenResponse.data.expires_in - 300) * 1000;
        return cachedToken;
    } catch (error) {
        console.error("Eroare la generarea token-ului Shopify:", error.response?.data || error.message);
        throw new Error("Nu s-a putut autentifica aplicația cu Shopify.");
    }
}

// Funcție care garantează returnarea codului de țară în format ISO2 (ex: IT, US, GB)
const countryNameMap = {
    "ITALY": "IT", "ITALIA": "IT",
    "ROMANIA": "RO", "ROMÂNIA": "RO",
    "GERMANY": "DE", "DEUTSCHLAND": "DE", "GERMANIA": "DE",
    "FRANCE": "FR", "FRANCIA": "FR",
    "SPAIN": "ES", "ESPANA": "ES", "ESPAÑA": "ES", "SPAGNA": "ES",
    "UNITED KINGDOM": "GB", "UK": "GB", "GREAT BRITAIN": "GB", "REGNO UNITO": "GB",
    "UNITED STATES": "US", "USA": "US", "STATI UNITI": "US",
    "AUSTRIA": "AT", "BELGIUM": "BE", "NETHERLANDS": "NL",
    "POLAND": "PL", "SWITZERLAND": "CH", "SVIZZERA": "CH", "PORTUGAL": "PT"
};

function getIso2Country(order) {
    const rawCode = order.shipping_address?.country_code || order.billing_address?.country_code;
    if (rawCode && rawCode.trim().length === 2) {
        return rawCode.trim().toUpperCase();
    }
    const rawName = (order.shipping_address?.country || order.billing_address?.country || "").trim().toUpperCase();
    if (countryNameMap[rawName]) {
        return countryNameMap[rawName];
    }
    if (rawName.length === 2) {
        return rawName;
    }
    return "IT"; // Valoare implicită ISO2 dacă adresa nu are țara completată
}

const catalogPantogar = {
    "P150": { name: "Pantogar® 150 capsule", ean: "2008331000049" },
    "P300": { name: "Pantogar® 300 capsule", ean: "2008331000056" },
    "PLM2": { name: "Pantogar® Lozione Uomo 2 × 100 ml", ean: "2008331000087" },
    "PLF2": { name: "Pantogar® Lozione Donna 2 × 100 ml", ean: "2008331000094" },
    "PSM":  { name: "Pantogar® Shampoo Uomo 200 ml", ean: "2008331000063" },
    "PSF":  { name: "Pantogar® Shampoo Donna 200 ml", ean: "2008331000070" },
    "P90":  { name: "Pantogar® 90 capsule", ean: "2008331000018" },
    "P180": { name: "Pantogar® 180 capsule", ean: "2008331000025" },
    "P270": { name: "Pantogar® 270 capsule", ean: "2008331000032" }
};

// 1. Endpoint Produse - channel_product_id inclus obligatoriu
app.get('/api/getProducts.json', (req, res) => {
    const requestedSku = req.query.sku || req.query.channel_product_id;
    const skusToReturn = requestedSku 
        ? Object.keys(catalogPantogar).filter(s => s === requestedSku)
        : Object.keys(catalogPantogar);

    const data = skusToReturn.map(sku => ({
        channel_product_id: String(sku),
        status: "1",
        sku: String(sku),
        name: catalogPantogar[sku].name,
        ean: catalogPantogar[sku].ean,
        price: "0.0000",
        weight: "0.0000"
    }));
    res.json({ data: data });
});

// 2. Endpoint Inventar - include atât sku cât și channel_product_id
app.get('/api/getInventory.json', async (req, res) => {
    try {
        const token = await getAccessToken();
        const requestedSku = req.query.sku || req.query.channel_product_id || req.query.product_id;

        const prodResponse = await axios.get(
            `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/products.json`,
            { headers: { 'X-Shopify-Access-Token': token } }
        );

        let inventoryItemsMap = {};
        prodResponse.data.products.forEach(product => {
            product.variants.forEach(variant => {
                if (variant.sku) {
                    inventoryItemsMap[variant.sku] = variant.inventory_item_id;
                }
            });
        });

        let inventoryData = [];
        const skusToProcess = requestedSku ? [requestedSku] : Object.keys(catalogPantogar);

        for (const sku of skusToProcess) {
            if (!catalogPantogar[sku]) continue;
            const inventoryItemId = inventoryItemsMap[sku];
            let qty = 0;

            if (inventoryItemId && SHOPIFY_LOCATION_ID) {
                try {
                    const levelRes = await axios.get(
                        `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/inventory_levels.json?inventory_item_ids=${inventoryItemId}&location_ids=${SHOPIFY_LOCATION_ID}`,
                        { headers: { 'X-Shopify-Access-Token': token } }
                    );
                    if (levelRes.data.inventory_levels && levelRes.data.inventory_levels.length > 0) {
                        qty = levelRes.data.inventory_levels[0].available || 0;
                    }
                } catch (err) {
                    console.error(`Eroare stoc pentru SKU ${sku}:`, err.message);
                }
            }

            inventoryData.push({
                channel_product_id: String(sku),
                sku: String(sku),
                location_id: SHOPIFY_LOCATION_ID || "1",
                qty: qty.toString()
            });
        }

        res.json({ data: inventoryData });
    } catch (error) {
        console.error("Error fetching inventory:", error.message);
        res.status(500).json({ error: "Failed to fetch inventory" });
    }
});

// 3. Endpoint Comenzi - country strict în format ISO2 (2 litere)
app.get('/api/getOrders.json', async (req, res) => {
    try {
        const token = await getAccessToken();
        const response = await axios.get(
            `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/orders.json?status=unfulfilled&fulfillment_status=unfulfilled`,
            { headers: { 'X-Shopify-Access-Token': token } }
        );
        const deagorOrders = response.data.orders.map(order => ({
            erp_id: order.id.toString(),
            ecommerce_id: order.order_number.toString(),
            grand_total: "0.0000",
            order_created_at: order.created_at.replace("T", " ").substring(0, 19), 
            firstname: order.shipping_address?.first_name || order.billing_address?.first_name || "",
            lastname: order.shipping_address?.last_name || order.billing_address?.last_name || "",
            city: order.shipping_address?.city || order.billing_address?.city || "",
            postcode: order.shipping_address?.zip || order.billing_address?.zip || "",
            street_1: order.shipping_address?.address1 || order.billing_address?.address1 || "",
            mobile: order.shipping_address?.phone || order.billing_address?.phone || "0000000000",
            country: getIso2Country(order),
            region_code: order.shipping_address?.province_code || order.billing_address?.province_code || "",
            email: order.email || "",
            payment_method: "prepaid",
            payment_method_title: "Prepaid",
            shipping_method: "standard",
            shipping_method_title: "Standard"
        }));
        res.json({ data: deagorOrders });
    } catch (error) {
        console.error("Error fetching orders:", error.message);
        res.status(500).json({ error: "Failed to fetch orders" });
    }
});

// 4. Endpoint Articole Comenzi - suportă filtrare după order_id și include channel_product_id
app.get('/api/getItems.json', async (req, res) => {
    try {
        const token = await getAccessToken();
        const requestedOrderId = req.query.order_id || req.query.erp_id || req.query.ecommerce_id;

        const response = await axios.get(
            `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/orders.json?status=unfulfilled&fulfillment_status=unfulfilled`,
            { headers: { 'X-Shopify-Access-Token': token } }
        );
        
        let deagorItems = [];
        response.data.orders.forEach(order => {
            if (requestedOrderId && order.id.toString() !== requestedOrderId && order.order_number.toString() !== requestedOrderId) {
                return;
            }

            order.line_items.forEach(item => {
                const sku = item.sku || "";
                const produs = catalogPantogar[sku];
                deagorItems.push({
                    order_id: order.id.toString(),
                    ecommerce_id: order.order_number.toString(),
                    channel_product_id: String(sku),
                    sku: String(sku),
                    name: produs ? produs.name : item.name,
                    ean: produs ? produs.ean : "LIPSA_EAN",
                    qty: item.quantity.toString(),
                    price: "0.0000",
                    ec_row_id: order.order_number.toString() + "-" + item.id.toString()
                });
            });
        });
        res.json({ data: deagorItems });
    } catch (error) {
        console.error("Error fetching items:", error.message);
        res.status(500).json({ error: "Failed to fetch items" });
    }
});

// 5. Endpoint AWB / Fulfillment Sync (POST)
app.post('/api/awb-sync', async (req, res) => {
    const { order_id, tracking_number, carrier } = req.body; 
    try {
        const token = await getAccessToken();
        const shopifyPayload = {
            fulfillment: {
                location_id: SHOPIFY_LOCATION_ID, 
                tracking_number: tracking_number,
                tracking_company: carrier || "GLS",
                notify_customer: true
            }
        };
        await axios.post(
            `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/orders/${order_id}/fulfillments.json`, 
            shopifyPayload, 
            { headers: { 'X-Shopify-Access-Token': token } }
        );
        res.status(200).send('OK');
    } catch (error) {
        console.error("Error sending AWB:", error.message);
        res.status(500).send('Error');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Middleware ruland pe portul ${PORT}`);
});
