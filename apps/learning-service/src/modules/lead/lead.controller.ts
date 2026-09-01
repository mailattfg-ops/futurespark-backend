import { Request, Response } from 'express';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { leadService } from './lead.service';
import { validateCreateLead, validateUpdateLead } from './lead.schema';

export const leadController = {
  async list(req: Request, res: Response) {
    const leads = await leadService.getAllLeads();
    return res.status(HTTP_STATUS.OK).json(successResponse(leads, 'Leads fetched successfully'));
  },

  async getById(req: Request, res: Response) {
    const lead = await leadService.getLeadById(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(lead, 'Lead fetched successfully'));
  },

  async create(req: Request, res: Response) {
    const input = validateCreateLead(req.body);
    // A telecaller adding a phone enquiry is not an ad conversion. Admin
    // requests carry a Bearer token; the public form's POST does not.
    const lead = await leadService.createLead({ ...input, staffEntry: !!req.headers.authorization });
    return res.status(HTTP_STATUS.CREATED).json(successResponse(lead, 'Lead created successfully'));
  },

  async update(req: Request, res: Response) {
    const input = validateUpdateLead(req.body);
    const lead = await leadService.updateLead(req.params.id, input);
    return res.status(HTTP_STATUS.OK).json(successResponse(lead, 'Lead updated successfully'));
  },

  async collectPayment(req: Request, res: Response) {
    const lead = await leadService.collectPayment(req.params.id, req.body);
    return res.status(HTTP_STATUS.OK).json(successResponse(lead, 'Payment details submitted successfully'));
  },

  async verifyPayment(req: Request, res: Response) {
    const adminUserId = (req as any).user?.id || 'ADMIN';
    const lead = await leadService.verifyPayment(req.params.id, adminUserId);
    return res.status(HTTP_STATUS.OK).json(successResponse(lead, 'Payment verified and lead enrolled successfully'));
  },

  async delete(req: Request, res: Response) {
    await leadService.deleteLead(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(null, 'Lead deleted successfully'));
  },
};
