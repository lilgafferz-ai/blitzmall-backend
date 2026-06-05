import React, { useState, useEffect } from 'react';
import './App.css';

function App() {
  const [page, setPage] = useState('login'); // login, shop, cart, order-confirmation
  const [customer, setCustomer] = useState(null);
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  const API_URL = 'http://localhost:5000/api';

  // Load products when app starts
  useEffect(() => {
    fetch(`${API_URL}/products`)
      .then(res => res.json())
      .then(data => setProducts(data))
      .catch(err => console.error('Error loading products:', err));
  }, []);

  // Customer login
  const handleLogin = async (e) => {
    e.preventDefault();
    
    try {
      const res = await fetch(`${API_URL}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone })
      });
      
      const data = await res.json();
      
      if (data.success) {
        setCustomer({ customerId: data.customerId, name });
        setPage('shop');
        setName('');
        setPhone('');
      }
    } catch (err) {
      console.error('Login error:', err);
    }
  };

  // Add item to cart
  const addToCart = (product) => {
    const existing = cart.find(item => item.id === product.id);
    
    if (existing) {
      setCart(cart.map(item =>
        item.id === product.id 
          ? { ...item, quantity: item.quantity + 1 }
          : item
      ));
    } else {
      setCart([...cart, { ...product, quantity: 1 }]);
    }
  };

  // Remove from cart
  const removeFromCart = (productId) => {
    setCart(cart.filter(item => item.id !== productId));
  };

  // Calculate total
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  // Place order
  const handleCheckout = async () => {
    if (cart.length === 0) return;

    try {
      const res = await fetch(`${API_URL}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: customer.customerId,
          items: cart
        })
      });

      const data = await res.json();

      if (data.success) {
        setPage('order-confirmation');
        setCart([]);
      }
    } catch (err) {
      console.error('Checkout error:', err);
    }
  };

  // LOGIN PAGE
  if (page === 'login') {
    return (
      <div className="container login-container">
        <div className="login-box">
          <h1>🏪 Your Shop</h1>
          <p>Login to place an order</p>
          
          <form onSubmit={handleLogin}>
            <input
              type="text"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <input
              type="tel"
              placeholder="Your phone (254712345678)"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
            <button type="submit">Login</button>
          </form>
        </div>
      </div>
    );
  }

  // SHOP PAGE
  if (page === 'shop') {
    return (
      <div className="container">
        <header className="header">
          <h1>🏪 Shop</h1>
          <p>Welcome, {customer.name}!</p>
        </header>

        <div className="content">
          {/* Products Section */}
          <div className="products-section">
            <h2>Available Items</h2>
            <div className="products-grid">
              {products.map(product => (
                <div key={product.id} className="product-card">
                  <div className="product-image">{product.image}</div>
                  <h3>{product.name}</h3>
                  <p className="price">KES {product.price}</p>
                  <button 
                    className="add-btn"
                    onClick={() => addToCart(product)}
                  >
                    Add to Cart
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Cart Section */}
          <div className="cart-section">
            <h2>Your Cart</h2>
            {cart.length === 0 ? (
              <p>Cart is empty</p>
            ) : (
              <>
                <div className="cart-items">
                  {cart.map(item => (
                    <div key={item.id} className="cart-item">
                      <span>{item.name}</span>
                      <span>x{item.quantity}</span>
                      <span>KES {item.price * item.quantity}</span>
                      <button 
                        className="remove-btn"
                        onClick={() => removeFromCart(item.id)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <div className="cart-total">
                  <strong>Total: KES {total}</strong>
                </div>
                <button 
                  className="checkout-btn"
                  onClick={handleCheckout}
                >
                  Place Order (Pay on Delivery)
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ORDER CONFIRMATION PAGE
  if (page === 'order-confirmation') {
    return (
      <div className="container confirmation-container">
        <div className="confirmation-box">
          <h1>✅ Order Placed!</h1>
          <p>Your order has been sent to the shop.</p>
          <p>You'll pay KES {total} on delivery.</p>
          <p>Check your messages for updates.</p>
          
          <button 
            className="checkout-btn"
            onClick={() => {
              setPage('shop');
              setCart([]);
            }}
          >
            Continue Shopping
          </button>
          <button 
            className="logout-btn"
            onClick={() => {
              setPage('login');
              setCustomer(null);
            }}
          >
            Logout
          </button>
        </div>
      </div>
    );
  }
}

export default App;
