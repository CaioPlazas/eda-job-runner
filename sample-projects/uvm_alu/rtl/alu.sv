// Registered ALU DUT (one-cycle latency). The `bug_en` input, when asserted,
// deliberately breaks SUB (computes a+b instead of a-b) so the UVM environment
// has something real to catch — the testbench drives it from a +BUG plusarg.
module alu #(
    parameter int W = 32
) (
    input  logic          clk,
    input  logic          rst_n,

    input  logic          in_valid,
    input  logic [3:0]    op,
    input  logic [W-1:0]  a,
    input  logic [W-1:0]  b,
    input  logic          bug_en,

    output logic          out_valid,
    output logic [W-1:0]  result
);
    typedef enum logic [3:0] {
        OP_ADD = 4'd0,
        OP_SUB = 4'd1,
        OP_AND = 4'd2,
        OP_OR  = 4'd3,
        OP_XOR = 4'd4,
        OP_SLL = 4'd5,
        OP_SRL = 4'd6,
        OP_SLT = 4'd7
    } op_e;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            out_valid <= 1'b0;
            result    <= '0;
        end else begin
            out_valid <= in_valid;
            unique case (op)
                OP_ADD: result <= a + b;
                OP_SUB: result <= bug_en ? (a + b) : (a - b); // injected bug
                OP_AND: result <= a & b;
                OP_OR:  result <= a | b;
                OP_XOR: result <= a ^ b;
                OP_SLL: result <= a << b[4:0];
                OP_SRL: result <= a >> b[4:0];
                OP_SLT: result <= { {(W-1){1'b0}}, ($signed(a) < $signed(b)) };
                default: result <= '0;
            endcase
        end
    end
endmodule
