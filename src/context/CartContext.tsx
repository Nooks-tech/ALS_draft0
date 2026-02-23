import React, { createContext, ReactNode, useContext, useState } from 'react';

// 1. Define the item structure (Restored from your old code)
export type CartItem = {
  id: string;
  name: string;
  price: number;
  quantity: number;
  image: string;
  customizations?: { [key: string]: any }; 
  uniqueId: string;
};

// 2. Define the Context Type (Updated with new functions)
export type CartContextType = {
  cartItems: CartItem[];
  addToCart: (product: any, quantity?: number) => void;
  removeFromCart: (product: any) => void;
  updateQuantity: (uniqueId: string, amount: number) => void;
  totalPrice: number;
  totalItems: number;
  orderType: 'delivery' | 'pickup';
  setOrderType: (type: 'delivery' | 'pickup') => void;
  selectedBranch: any;
  setSelectedBranch: (branch: any) => void;
  deliveryAddress: { address: string; lat?: number; lng?: number; city?: string } | null;
  setDeliveryAddress: (addr: { address: string; lat?: number; lng?: number; city?: string } | null) => void;
  clearCart: () => void;
  /** Re-order: set cart and order type from a placed order (e.g. for Re-order button). */
  setCartFromOrder: (order: { items: CartItem[]; orderType: 'delivery' | 'pickup'; branchId?: string; branchName?: string; deliveryAddress?: string; deliveryLat?: number; deliveryLng?: number }) => void;
};

const CartContext = createContext<CartContextType | undefined>(undefined);

export const CartProvider = ({ children }: { children: ReactNode }) => {
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [orderType, setOrderType] = useState<'delivery' | 'pickup'>('pickup');
  const [selectedBranch, setSelectedBranch] = useState<{ id: string; name: string; address: string; distance?: string } | null>(null);
  const [deliveryAddress, setDeliveryAddress] = useState<{ address: string; lat?: number; lng?: number; city?: string } | null>(null);

  // RESTORED: Your smart Unique ID generator
  const generateUniqueId = (product: any) => {
    if (!product.customizations || Object.keys(product.customizations).length === 0) return product.id;
    const optionsString = Object.entries(product.customizations)
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB)) 
      .map(([_, val]: any) => val.name)
      .join('-');
    return `${product.id}-${optionsString}`;
  };

  const addToCart = (product: any, quantity: number = 1) => {
    const qty = Math.max(1, Math.floor(quantity));
    setCartItems((prevItems) => {
      const uniqueId = generateUniqueId(product);
      const existingItem = prevItems.find((item) => item.uniqueId === uniqueId);

      if (existingItem) {
        return prevItems.map((item) =>
          item.uniqueId === uniqueId
            ? { ...item, quantity: item.quantity + qty }
            : item
        );
      } else {
        return [...prevItems, { ...product, uniqueId, quantity: qty }];
      }
    });
  };

  // ADDED: Specifically for the + and - buttons in the Cart Screen
  const updateQuantity = (uniqueId: string, amount: number) => {
    setCartItems((prevItems) => 
      prevItems.map((item) => 
        item.uniqueId === uniqueId 
          ? { ...item, quantity: item.quantity + amount } 
          : item
      ).filter(item => item.quantity > 0)
    );
  };

  const removeFromCart = (product: any) => {
    setCartItems((prevItems) => {
      const uniqueId = product.uniqueId;
      return prevItems.filter((item) => item.uniqueId !== uniqueId);
    });
  };

  const totalItems = cartItems.reduce((sum, item) => sum + item.quantity, 0);
  const totalPrice = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  const clearCart = () => {
    setCartItems([]);
  };

  const setCartFromOrder = (order: {
    items: CartItem[];
    orderType: 'delivery' | 'pickup';
    branchId?: string;
    branchName?: string;
    deliveryAddress?: string;
    deliveryLat?: number;
    deliveryLng?: number;
  }) => {
    setCartItems(order.items);
    setOrderType(order.orderType);
    if (order.branchId != null && order.branchName != null) {
      setSelectedBranch({ id: order.branchId, name: order.branchName, address: '' });
    }
    if (order.orderType === 'delivery' && order.deliveryAddress) {
      setDeliveryAddress({
        address: order.deliveryAddress,
        lat: order.deliveryLat,
        lng: order.deliveryLng,
      });
    } else {
      setDeliveryAddress(null);
    }
  };

  return (
    <CartContext.Provider
      value={{
        cartItems,
        addToCart,
        removeFromCart,
        updateQuantity,
        totalPrice,
        totalItems,
        orderType,
        setOrderType,
        selectedBranch,
        setSelectedBranch,
        deliveryAddress,
        setDeliveryAddress,
        clearCart,
        setCartFromOrder,
      }}
    >
      {children}
    </CartContext.Provider>
  );
};

export const useCart = () => {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return context;
};