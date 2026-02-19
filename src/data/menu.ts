export const CATEGORIES = ["All", "Hot Coffee", "Iced Coffee", "Matcha", "Brewed", "Bakery", "Healthy", "Desserts"];

export const PRODUCTS = [
  { id: '1', name: 'Spanish Latte', price: 18, category: 'Hot Coffee', description: 'Rich espresso with sweetened condensed milk.', image: 'https://images.unsplash.com/photo-1570968992193-96ab70c74baa?w=400', modifierGroups: [{ id: 'mg1', title: 'Choose Beans', options: [{ name: 'Ethiopian', price: 0 }, { name: 'Brazilian', price: 0 }] }, { id: 'mg2', title: 'Milk Type', options: [{ name: 'Full Fat', price: 0 }, { name: 'Oat Milk', price: 3 }, { name: 'Almond Milk', price: 3 }] }] },
  { id: '2', name: 'Flat White', price: 16, category: 'Hot Coffee', description: 'Velvety microfoam over a double shot.', image: 'https://images.unsplash.com/photo-1577968897966-3d4325b36b61?w=400', modifierGroups: [{ id: 'mg1', title: 'Coffee Intensity', options: [{ name: 'Regular', price: 0 }, { name: 'Extra Shot', price: 4 }] }, { id: 'mg2', title: 'Milk Type', options: [{ name: 'Full Fat', price: 0 }, { name: 'Soy Milk', price: 3 }] }] },
  { id: '3', name: 'Cortado', price: 14, category: 'Hot Coffee', description: 'Equal parts espresso and warm silky milk.', image: 'https://images.unsplash.com/photo-1534706936160-d5ee67737049?w=400', modifierGroups: [{ id: 'mg1', title: 'Bean Selection', options: [{ name: 'House Blend', price: 0 }, { name: 'Single Origin', price: 3 }] }] },
  { id: '4', name: 'Cappuccino', price: 16, category: 'Hot Coffee', description: 'Classic espresso with thick airy foam.', image: 'https://images.unsplash.com/photo-1572442388796-11668a67e53d?w=400', modifierGroups: [{ id: 'mg1', title: 'Topping', options: [{ name: 'Cinnamon', price: 0 }, { name: 'Cocoa Powder', price: 0 }, { name: 'None', price: 0 }] }] },
  { id: '5', name: 'Iced Pistachio Latte', price: 24, category: 'Iced Coffee', description: 'Creamy milk with premium pistachio sauce.', image: 'https://images.unsplash.com/photo-1594266050516-0ad6da68069a?w=400', modifierGroups: [{ id: 'mg1', title: 'Sweetness', options: [{ name: 'Normal', price: 0 }, { name: 'Less Sugar', price: 0 }, { name: 'No Sugar', price: 0 }] }, { id: 'mg2', title: 'Extra Topping', options: [{ name: 'None', price: 0 }, { name: 'Crushed Pistachio', price: 3 }] }] },
  { id: '6', name: 'Iced Americano', price: 14, category: 'Iced Coffee', description: 'Clean and refreshing double shot over ice.', image: 'https://images.unsplash.com/photo-1551046710-23b0d4c6ca91?w=400', modifierGroups: [{ id: 'mg1', title: 'Roast Type', options: [{ name: 'Medium Roast', price: 0 }, { name: 'Dark Roast', price: 0 }] }] },
  { id: '7', name: 'Cold Brew', price: 20, category: 'Iced Coffee', description: 'Steeped for 18 hours for maximum smoothness.', image: 'https://images.unsplash.com/photo-1517701604599-bb29b565090c?w=400', modifierGroups: [{ id: 'mg1', title: 'Flavor Hint', options: [{ name: 'Original', price: 0 }, { name: 'Vanilla Hint', price: 2 }, { name: 'Caramel Hint', price: 2 }] }] },
  { id: '8', name: 'Ceremonial Matcha', price: 22, category: 'Matcha', description: 'Pure Japanese matcha whisked to perfection.', image: 'https://images.unsplash.com/photo-1582781201157-11adee945AF5?w=400', modifierGroups: [{ id: 'mg1', title: 'Temperature', options: [{ name: 'Iced', price: 0 }, { name: 'Hot', price: 0 }] }, { id: 'mg2', title: 'Milk', options: [{ name: 'Oat Milk', price: 0 }, { name: 'Coconut Milk', price: 0 }] }] },
  { id: '9', name: 'Matcha Strawberry', price: 26, category: 'Matcha', description: 'Matcha layered with fresh strawberry purée.', image: 'https://images.unsplash.com/photo-1576092768241-dec231879fc3?w=400', modifierGroups: [{ id: 'mg1', title: 'Sweetness Level', options: [{ name: '50%', price: 0 }, { name: '100%', price: 0 }] }] },
  { id: '10', name: 'V60 Dripper', price: 22, category: 'Brewed', description: 'Hand-poured coffee with precision.', image: 'https://images.unsplash.com/photo-1544787210-2211d4301f22?w=400', modifierGroups: [{ id: 'mg1', title: 'Bean Origin', options: [{ name: 'Ethiopia (Berry)', price: 0 }, { name: 'Colombia (Nuts)', price: 0 }, { name: 'Saudi (Classic)', price: 0 }] }] },
  { id: '11', name: 'Chemex', price: 24, category: 'Brewed', description: 'Clear and bright pour-over for two.', image: 'https://images.unsplash.com/photo-1512539391578-1a3eb1f3874e?w=400', modifierGroups: [{ id: 'mg1', title: 'Roast', options: [{ name: 'Light', price: 0 }, { name: 'Medium', price: 0 }] }] },
  { id: '12', name: 'Butter Croissant', price: 12, category: 'Bakery', description: 'Flaky, buttery French-style pastry.', image: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=400', modifierGroups: [{ id: 'mg1', title: 'Preparation', options: [{ name: 'Warm', price: 0 }, { name: 'Room Temp', price: 0 }] }, { id: 'mg2', title: 'Sides', options: [{ name: 'None', price: 0 }, { name: 'Butter', price: 1 }, { name: 'Jam', price: 2 }] }] },
  { id: '13', name: 'Pain au Chocolat', price: 14, category: 'Bakery', description: 'Butter pastry filled with dark chocolate.', image: 'https://images.unsplash.com/photo-1530610476181-d83430b64dcd?w=400', modifierGroups: [{ id: 'mg1', title: 'Warm up?', options: [{ name: 'Yes', price: 0 }, { name: 'No', price: 0 }] }] },
  { id: '14', name: 'Cheese Danishes', price: 15, category: 'Bakery', description: 'Sweet dough with cream cheese filling.', image: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=400', modifierGroups: [{ id: 'mg1', title: 'Style', options: [{ name: 'Regular', price: 0 }, { name: 'With Honey', price: 2 }] }] },
  { id: '15', name: 'Acai Bowl', price: 38, category: 'Healthy', description: 'Organic acai topped with granola and fruit.', image: 'https://images.unsplash.com/photo-1590301157890-4810ed352733?w=400', modifierGroups: [{ id: 'mg1', title: 'Add Nut Butter', options: [{ name: 'None', price: 0 }, { name: 'Peanut Butter', price: 4 }, { name: 'Almond Butter', price: 5 }] }, { id: 'mg2', title: 'Toppings', options: [{ name: 'Extra Granola', price: 3 }, { name: 'Coconut Flakes', price: 2 }] }] },
  { id: '16', name: 'Tuna Wrap', price: 28, category: 'Healthy', description: 'High-protein tuna mix with fresh greens.', image: 'https://images.unsplash.com/photo-1509722747041-619f392e921b?w=400', modifierGroups: [{ id: 'mg1', title: 'Bread Type', options: [{ name: 'Whole Wheat', price: 0 }, { name: 'White Tortilla', price: 0 }] }] },
  { id: '17', name: 'Peanut Butter Toast', price: 18, category: 'Healthy', description: 'Toasted sourdough with organic peanut butter.', image: 'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=400', modifierGroups: [{ id: 'mg1', title: 'Fruit Topping', options: [{ name: 'Banana', price: 0 }, { name: 'Blueberries', price: 3 }] }] },
  { id: '18', name: 'San Sebastian', price: 28, category: 'Desserts', description: 'Creamy burnt cheesecake with chocolate.', image: 'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?w=400', modifierGroups: [{ id: 'mg1', title: 'Chocolate Pour', options: [{ name: 'Milk Chocolate', price: 0 }, { name: 'Dark Chocolate', price: 0 }, { name: 'No Chocolate', price: 0 }] }] },
  { id: '19', name: 'Tiramisu', price: 26, category: 'Desserts', description: 'Coffee-soaked ladyfingers with mascarpone.', image: 'https://images.unsplash.com/photo-1571877227200-a0d98ea607e9?w=400', modifierGroups: [{ id: 'mg1', title: 'Serving Size', options: [{ name: 'Individual Cup', price: 0 }, { name: 'Sharing Box', price: 60 }] }] },
];

export const PROMOS = [
  { id: 1, title: 'Morning Brew', subtitle: '50% OFF', color: '#0D9488', image: 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=400' },
  { id: 2, title: 'Matcha Monday', subtitle: 'Buy 1 Get 1', color: '#65a30d', image: 'https://images.unsplash.com/photo-1515823064-d6e0c04616a7?w=400' },
];

export const BRANCHES = [
  {
    id: 'madinah-1',
    name: 'Nooks Madinah - Central',
    address: 'Prince Mohammed Bin Abdulaziz Road, Near Prophet\'s Mosque',
    distance: '0.8 km',
  },
  {
    id: 'madinah-2',
    name: 'Nooks Madinah - King Fahd Road',
    address: 'King Fahd Road, Al Madinah Al Munawwarah',
    distance: '2.1 km',
  },
  {
    id: 'riyadh-1',
    name: 'Nooks Riyadh - Olaya',
    address: 'Olaya Street, Olaya District',
    distance: '1.5 km',
  },
  {
    id: 'riyadh-2',
    name: 'Nooks Riyadh - King Fahd Road',
    address: 'King Fahd Road, Riyadh',
    distance: '3.2 km',
  },
];
