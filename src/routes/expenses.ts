import express from 'express';
import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { PrismaClient, UserRole } from '@prisma/client';
import { authenticate, authorize } from '../middleware/auth';
import { sendEmail, emailTemplates } from '../utils/email';

const router = express.Router();
const prisma = new PrismaClient();

// Get expenses for an event
router.get('/event/:eventId', authenticate, async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;

    const expenses = await prisma.expense.findMany({
      where: { eventId },
      include: {
        category: true,
        addedBy: {
          select: { id: true, name: true, email: true }
        },
        product: true
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(expenses);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

// Get expense summary for an event
router.get('/event/:eventId/summary', authenticate, async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;

    const budgets = await prisma.budget.findMany({
      where: { eventId },
      include: { category: true }
    });

    const expenses = await prisma.expense.findMany({
      where: { eventId },
      include: { category: true }
    });

    const summary = budgets.map(budget => {
      const categoryExpenses = expenses.filter(expense => expense.categoryId === budget.categoryId);
      const totalExpense = categoryExpenses.reduce((sum, expense) => sum + expense.amount, 0);

      return {
        category: budget.category,
        budgetAmount: budget.approvedAmount || budget.amount,
        totalExpense: totalExpense,
        remaining: (budget.approvedAmount || budget.amount) - totalExpense,
        expenseCount: categoryExpenses.length
      };
    });

    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch expense summary' });
  }
});

// Create expense
router.post('/', authenticate, authorize([UserRole.FACILITIES_TEAM, UserRole.FINANCE_TEAM, UserRole.ADMIN]), [
  body('eventId').optional().isUUID(),
  body('workshopId').optional().isUUID(),
  body('categoryId').isUUID(),
  body('itemName').notEmpty().trim(),
  body('quantity').isFloat({ min: 0 }),
  body('unitPrice').isFloat({ min: 0 }),
  body('amount').isFloat({ min: 0 }),
  body('remarks').optional().trim(),
  body('productId').optional().isUUID(),
], async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    }

    const expenseData = {
      ...req.body,
      addedById: req.user!.userId
    };

    const expense = await prisma.expense.create({
      data: expenseData,
      include: {
        category: true,
        addedBy: {
          select: { id: true, name: true, email: true }
        },
        product: true,
        event: {
          include: {
            coordinator: {
              select: { id: true, name: true, email: true }
            }
          }
        }
      }
    });

    // Send email to event coordinator
    if (expense.event?.coordinator) {
      try {
        const emailContent = emailTemplates.expenseAdded(
          expense.event.title,
          expense.itemName,
          expense.amount,
          expense.addedBy.name
        );
        await sendEmail({
          to: expense.event.coordinator.email,
          subject: emailContent.subject,
          html: emailContent.html
        });
      } catch (emailError) {
        console.error('Failed to send expense added email:', emailError);
      }
    }

    res.status(201).json(expense);
  } catch (error) {
    console.error('Error creating expense:', error);
    res.status(500).json({ error: 'Failed to create expense' });
  }
});

// Create bulk expenses (for multi-item expenses)
router.post('/bulk', authenticate, authorize([UserRole.FACILITIES_TEAM, UserRole.FINANCE_TEAM, UserRole.ADMIN]), [
  body('expenses').isArray({ min: 1 }),
  body('expenses.*.eventId').optional().isUUID(),
  body('expenses.*.workshopId').optional().isUUID(),
  body('expenses.*.categoryId').isUUID(),
  body('expenses.*.itemName').notEmpty().trim(),
  body('expenses.*.quantity').isFloat({ min: 0 }),
  body('expenses.*.unitPrice').isFloat({ min: 0 }),
  body('expenses.*.amount').isFloat({ min: 0 }),
  body('expenses.*.remarks').optional().trim(),
  body('expenses.*.productId').optional().isUUID(),
  body('sendEmail').optional().isBoolean(),
], async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    }

    const { expenses, sendEmail: shouldSendEmail = true } = req.body;
    const createdExpenses = [];

    for (const expenseData of expenses) {
      const expense = await prisma.expense.create({
        data: {
          ...expenseData,
          addedById: req.user!.userId
        },
        include: {
          category: true,
          addedBy: {
            select: { id: true, name: true, email: true }
          },
          product: true,
          event: {
            include: {
              coordinator: {
                select: { id: true, name: true, email: true }
              }
            }
          }
        }
      });

      createdExpenses.push(expense);
    }

    // Send single email notification for bulk expenses
    if (shouldSendEmail && createdExpenses.length > 0) {
      const firstExpense = createdExpenses[0];
      if (firstExpense.event?.coordinator) {
        try {
          const emailContent = emailTemplates.bulkExpenseAdded(
            firstExpense.event.title,
            createdExpenses.length,
            createdExpenses.reduce((sum, exp) => sum + exp.amount, 0),
            firstExpense.addedBy.name
          );
          await sendEmail({
            to: firstExpense.event.coordinator.email,
            subject: emailContent.subject,
            html: emailContent.html
          });
        } catch (emailError) {
          console.error('Failed to send bulk expense email:', emailError);
        }
      }
    }

    res.status(201).json(createdExpenses);
  } catch (error) {
    console.error('Error creating bulk expenses:', error);
    res.status(500).json({ error: 'Failed to create bulk expenses' });
  }
});

// Update expense
router.put('/:id', authenticate, authorize([UserRole.FACILITIES_TEAM, UserRole.FINANCE_TEAM, UserRole.ADMIN]), [
  body('itemName').optional().notEmpty().trim(),
  body('quantity').optional().isFloat({ min: 0 }),
  body('unitPrice').optional().isFloat({ min: 0 }),
  body('amount').optional().isFloat({ min: 0 }),
  body('remarks').optional().trim(),
], async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    }

    const { id } = req.params;

    const expense = await prisma.expense.update({
      where: { id },
      data: req.body,
      include: {
        category: true,
        addedBy: {
          select: { id: true, name: true, email: true }
        },
        product: true
      }
    });

    res.json(expense);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update expense' });
  }
});

// Delete expense
router.delete('/:id', authenticate, authorize([UserRole.FACILITIES_TEAM, UserRole.FINANCE_TEAM, UserRole.ADMIN]), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await prisma.expense.delete({
      where: { id }
    });

    res.json({ message: 'Expense deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete expense' });
  }
});

export default router;