const express = require("express");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = 3000;
const SECRET_KEY = "food_delivery_secret_123";

app.use(express.json());

const DATA_DIR = path.join(__dirname, "data");

function readData(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf-8"));
}
function writeData(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// ---------- Auth Middleware ----------
function authenticate(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(401).json({ message: "Token missing. Login karo pehle." });

  const token = authHeader.split(" ")[1];
  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) return res.status(403).json({ message: "Invalid ya expired token." });
    req.user = user;
    next();
  });
}

// ==================================================================
// AUTH ROUTES
// ==================================================================

app.post("/auth/register", (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ message: "name, email, password required hain." });
  }

  const users = readData("users.json");
  const exists = users.find((u) => u.email === email);
  if (exists) return res.status(400).json({ message: "Yeh email already registered hai." });

  const hashedPassword = bcrypt.hashSync(password, 8);
  const newUser = {
    id: users.length > 0 ? users[users.length - 1].id + 1 : 1,
    name,
    email,
    password: hashedPassword,
  };
  users.push(newUser);
  writeData("users.json", users);

  res.status(201).json({ message: "Registration successful", userId: newUser.id });
});

app.post("/auth/login", (req, res) => {
  const { email, password } = req.body;
  const users = readData("users.json");
  const user = users.find((u) => u.email === email);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ message: "Email ya password galat hai." });
  }

  const token = jwt.sign({ id: user.id, email: user.email }, SECRET_KEY, { expiresIn: "2h" });
  res.json({ message: "Login successful", token });
});

// ==================================================================
// RESTAURANT ROUTES (public)
// ==================================================================

// Get all restaurants (filters: cuisine, minRating, search)
app.get("/restaurants", (req, res) => {
  let restaurants = readData("restaurants.json");
  const { cuisine, minRating, search } = req.query;

  if (cuisine) restaurants = restaurants.filter((r) => (r.cuisine || "").toLowerCase() === cuisine.toLowerCase());
  if (minRating) restaurants = restaurants.filter((r) => r.rating >= Number(minRating));
  if (search) restaurants = restaurants.filter((r) => (r.name || "").toLowerCase().includes(search.toLowerCase()));

  // Return without full menu for list view (lighter response)
  const summary = restaurants.map(({ id, name, cuisine, rating, deliveryTime }) => ({
    id, name, cuisine, rating, deliveryTime,
  }));
  res.json(summary);
});

// Get single restaurant with full menu
app.get("/restaurants/:id", (req, res) => {
  const restaurants = readData("restaurants.json");
  const restaurant = restaurants.find((r) => r.id == req.params.id);
  if (!restaurant) return res.status(404).json({ message: "Restaurant not found" });
  res.json(restaurant);
});

// Get menu of a restaurant
app.get("/restaurants/:id/menu", (req, res) => {
  const restaurants = readData("restaurants.json");
  const restaurant = restaurants.find((r) => r.id == req.params.id);
  if (!restaurant) return res.status(404).json({ message: "Restaurant not found" });
  res.json(restaurant.menu);
});

// ==================================================================
// CART ROUTES (login required) — cart is tied to ONE restaurant at a time
// ==================================================================

app.get("/cart", authenticate, (req, res) => {
  const carts = readData("carts.json");
  const myCart = carts.find((c) => c.userId === req.user.id) || { userId: req.user.id, restaurantId: null, items: [] };
  res.json(myCart);
});

app.post("/cart/add", authenticate, (req, res) => {
  const { restaurantId, itemId, quantity } = req.body;
  const restaurants = readData("restaurants.json");
  const restaurant = restaurants.find((r) => r.id === restaurantId);
  if (!restaurant) return res.status(404).json({ message: "Restaurant not found" });

  const menuItem = restaurant.menu.find((m) => m.itemId === itemId);
  if (!menuItem) return res.status(404).json({ message: "Menu item not found" });

  const carts = readData("carts.json");
  let myCart = carts.find((c) => c.userId === req.user.id);

  if (!myCart) {
    myCart = { userId: req.user.id, restaurantId, items: [] };
    carts.push(myCart);
  }

  // Rule: cart can only contain items from ONE restaurant at a time
  if (myCart.items.length > 0 && myCart.restaurantId !== restaurantId) {
    return res.status(400).json({
      message: "Cart mein already doosre restaurant ke items hain. Pehle cart clear karo.",
    });
  }

  myCart.restaurantId = restaurantId;
  const existingItem = myCart.items.find((i) => i.itemId === itemId);
  if (existingItem) {
    existingItem.quantity += quantity;
  } else {
    myCart.items.push({ itemId, quantity, price: menuItem.price, name: menuItem.name });
  }

  writeData("carts.json", carts);
  res.status(201).json(myCart);
});

app.patch("/cart/update", authenticate, (req, res) => {
  const { itemId, quantity } = req.body;
  const carts = readData("carts.json");
  const myCart = carts.find((c) => c.userId === req.user.id);
  if (!myCart) return res.status(404).json({ message: "Cart not found" });

  const item = myCart.items.find((i) => i.itemId === itemId);
  if (!item) return res.status(404).json({ message: "Item cart mein nahi hai" });

  item.quantity = quantity;
  writeData("carts.json", carts);
  res.json(myCart);
});

app.delete("/cart/remove/:itemId", authenticate, (req, res) => {
  const carts = readData("carts.json");
  const myCart = carts.find((c) => c.userId === req.user.id);
  if (!myCart) return res.status(404).json({ message: "Cart not found" });

  myCart.items = myCart.items.filter((i) => i.itemId != req.params.itemId);
  if (myCart.items.length === 0) myCart.restaurantId = null;

  writeData("carts.json", carts);
  res.json(myCart);
});

// ==================================================================
// ORDER ROUTES (login required)
// ==================================================================

app.post("/orders", authenticate, (req, res) => {
  const carts = readData("carts.json");
  const myCart = carts.find((c) => c.userId === req.user.id);

  if (!myCart || myCart.items.length === 0) {
    return res.status(400).json({ message: "Cart khali hai, order nahi ban sakta." });
  }

  const total = myCart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const orders = readData("orders.json");
  const newOrder = {
    id: orders.length > 0 ? orders[orders.length - 1].id + 1 : 1,
    userId: req.user.id,
    restaurantId: myCart.restaurantId,
    items: myCart.items,
    total,
    status: "placed", // placed -> preparing -> out_for_delivery -> delivered
    createdAt: new Date().toISOString(),
  };
  orders.push(newOrder);
  writeData("orders.json", orders);

  myCart.items = [];
  myCart.restaurantId = null;
  writeData("carts.json", carts);

  res.status(201).json(newOrder);
});

app.get("/orders", authenticate, (req, res) => {
  const orders = readData("orders.json");
  const myOrders = orders.filter((o) => o.userId === req.user.id);
  res.json(myOrders);
});

app.get("/orders/:id", authenticate, (req, res) => {
  const orders = readData("orders.json");
  const order = orders.find((o) => o.id == req.params.id && o.userId === req.user.id);
  if (!order) return res.status(404).json({ message: "Order not found" });
  res.json(order);
});

// Update order status (e.g. simulate restaurant/delivery updates)
app.patch("/orders/:id/status", authenticate, (req, res) => {
  const { status } = req.body;
  const validStatuses = ["placed", "preparing", "out_for_delivery", "delivered", "cancelled"];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ message: `status must be one of: ${validStatuses.join(", ")}` });
  }

  const orders = readData("orders.json");
  const order = orders.find((o) => o.id == req.params.id && o.userId === req.user.id);
  if (!order) return res.status(404).json({ message: "Order not found" });

  order.status = status;
  writeData("orders.json", orders);
  res.json(order);
});

// ==================================================================
app.listen(PORT, () => {
  console.log(`✅ Food Delivery API chal raha hai: http://localhost:${PORT}`);
});
