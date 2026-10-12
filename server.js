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

app.get('/api/getProducts.json', (req, res) => {
    const data = Object.keys(catalogPantogar).map(sku => ({
        channel_product_id: sku,
        status: "1",
        sku: sku,
        name: catalogPantogar[sku].name,
        ean: catalogPantogar[sku].ean,
        price: "0.0000",
        weight: "0.0000"
    }));
    res.json({ data: data });
});

// Endpoint nou pentru Inventar Real din Shopify
app.get('/api/getInventory.json', async (req, res) => {
    try {
        const token = await getAccessToken();
        
        // 1. Preluăm toate produsele din Shopify pentru a mapa SKU-urile la inventory_item_id
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

        // 2. Pentru fiecare SKU din catalogul nostru, interogăm stocul pe locație
        for (const sku of Object.keys(catalogPantogar)) {
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
                sku: sku,
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
            firstname: order.shipping_address?.first_name || "",
            lastname: order.shipping_address?.last_name || "",
            city: order.shipping_address?.city || "",
            postcode: order.shipping_address?.zip || "",
            street_1: order.shipping_address?.address1 || "",
            mobile: order.shipping_address?.phone || "0000000000",
            country: order.shipping_address?.country_code || "",
            region_code: order.shipping_address?.province_code || "",
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

app.get('/api/getItems.json', async (req, res) => {
    try {
        const token = await getAccessToken();
        const response = await axios.get(
            `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/orders.json?status=unfulfilled&fulfillment_status=unfulfilled`,
            { headers: { 'X-Shopify-Access-Token': token } }
        );
        let deagorItems = [];
        response.data.orders.forEach(order => {
            order.line_items.forEach(item => {
                const sku = item.sku;
                const produs = catalogPantogar[sku];
                deagorItems.push({
                    channel_product_id: sku,
                    sku: sku,
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

app.post('/api/awb-sync', async (req, res) => {
    const { order_id, tracking_number, carrier } = req.body; 
    try {
        const token = await getAccessToken();
        const shopifyPayload = {
            fulfillment: {
                location_id: SHOPIFY_LOCATION_ID, 
                tracking_number: tracking_number,
                tracking_company: carrier,
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
