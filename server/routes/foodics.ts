import { Router } from 'express';
import { foodicsService } from '../services/foodics';

export const foodicsRouter = Router();

foodicsRouter.get('/menu', async (req, res) => {
  try {
    const menu = await foodicsService.getMenu();
    res.json(menu);
  } catch (error: any) {
    console.error('Foodics menu error:', error?.message);
    res.status(error?.status || 500).json({
      error: error?.message || 'Failed to fetch menu',
    });
  }
});

foodicsRouter.get('/branches', async (req, res) => {
  try {
    const branches = await foodicsService.getBranches();
    res.json(branches);
  } catch (error: any) {
    console.error('Foodics branches error:', error?.message);
    res.status(error?.status || 500).json({
      error: error?.message || 'Failed to fetch branches',
    });
  }
});

foodicsRouter.post('/orders', async (req, res) => {
  try {
    const order = await foodicsService.createOrder(req.body);
    res.json(order);
  } catch (error: any) {
    console.error('Foodics order error:', error?.message);
    res.status(error?.status || 500).json({
      error: error?.message || 'Failed to create order',
    });
  }
});
